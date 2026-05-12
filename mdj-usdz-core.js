(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MDJUSDZ = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_COLOR = [0.72, 0.76, 0.73, 1];
  const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const UNIT_SCALES = {
    in: 0.0254,
    ft: 0.3048,
    mm: 0.001,
    cm: 0.01,
    m: 1
  };

  let crcTable = null;

  function parseMDJText(text, options) {
    const parsed = JSON.parse(text);
    const roots = extractMDJRoots(parsed);
    return buildMDJScene(roots, options || {});
  }

  function extractMDJRoots(parsed) {
    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (parsed && Array.isArray(parsed.objects)) {
      return parsed.objects;
    }

    if (parsed && parsed.model && Array.isArray(parsed.model.objects)) {
      return parsed.model.objects;
    }

    throw new Error("MDJ root must be an array or an object with an objects array.");
  }

  function buildMDJScene(roots, options) {
    const scene = {
      name: options.fileName || "MDJ Model",
      geometries: [],
      namedGeometries: new Map(),
      namedColors: new Map(),
      pendingReferences: [],
      renderItems: [],
      meshCount: 0,
      referenceCount: 0,
      unresolvedReferenceCount: 0,
      triangleCount: 0,
      vertexCount: 0,
      bounds: createEmptyBounds(),
      radius: 1,
      maxSpan: 1,
      span: [1, 1, 1],
      centerScaleMatrix: copyMatrix(IDENTITY)
    };

    const rootList = Array.isArray(roots) ? roots : [roots];
    for (const object of rootList) {
      buildNode(scene, object, IDENTITY, DEFAULT_COLOR);
    }

    resolvePendingReferences(scene);
    finalizeScene(scene);
    return scene;
  }

  function buildNode(scene, object, parentWorldMatrix, inheritedColor) {
    if (!object || typeof object !== "object") {
      return null;
    }

    const localMatrix = matrixFromObject(object);
    const worldMatrix = mat4();
    multiply(worldMatrix, parentWorldMatrix, localMatrix);

    const objectName = typeof object.name === "string" ? object.name : "";
    const ownColor = chooseObjectColor(scene, object, inheritedColor);
    if (objectName) {
      scene.namedColors.set(objectName, ownColor);
    }

    let geometry = null;
    let isReference = false;

    if (Array.isArray(object.vertexpositions)) {
      geometry = createGeometryData(object, objectName || "mesh");
      scene.geometries.push(geometry);
      if (objectName) {
        scene.namedGeometries.set(objectName, geometry);
      }
    } else if (typeof object.referenceobjectname === "string") {
      geometry = scene.namedGeometries.get(object.referenceobjectname) || null;
      isReference = true;
      scene.referenceCount += 1;
    }

    if (geometry) {
      addRenderItem(scene, geometry, worldMatrix, ownColor, objectName, isReference);
      if (objectName && isReference) {
        scene.namedGeometries.set(objectName, geometry);
      }
    } else if (isReference) {
      scene.pendingReferences.push({
        refName: object.referenceobjectname,
        objectName,
        worldMatrix: copyMatrix(worldMatrix),
        color: ownColor
      });
    }

    if (Array.isArray(object.objects)) {
      for (const child of object.objects) {
        buildNode(scene, child, worldMatrix, ownColor);
      }
    }

    return worldMatrix;
  }

  function resolvePendingReferences(scene) {
    if (!scene.pendingReferences.length) {
      return;
    }

    let unresolved = 0;
    for (const pending of scene.pendingReferences) {
      const geometry = scene.namedGeometries.get(pending.refName);
      if (geometry) {
        const refColor = scene.namedColors.get(pending.refName);
        const color = pending.color || refColor || DEFAULT_COLOR;
        addRenderItem(scene, geometry, pending.worldMatrix, color, pending.objectName, true);
        if (pending.objectName) {
          scene.namedGeometries.set(pending.objectName, geometry);
        }
      } else {
        unresolved += 1;
      }
    }

    scene.unresolvedReferenceCount = unresolved;
    scene.pendingReferences = [];
  }

  function addRenderItem(scene, geometry, worldMatrix, color, name, isReference) {
    const item = {
      geometry,
      worldMatrix: copyMatrix(worldMatrix),
      normalizedMatrix: mat4(),
      color: color || DEFAULT_COLOR,
      name: name || geometry.label,
      isReference: Boolean(isReference)
    };

    scene.renderItems.push(item);
    scene.triangleCount += geometry.triangleCount;
    scene.vertexCount += geometry.vertexCount;
    if (!isReference) {
      scene.meshCount += 1;
    }
  }

  function createGeometryData(object, label) {
    const sourcePositions = object.vertexpositions;
    const sourceIndexes = Array.isArray(object.vertexindexes) ? object.vertexindexes : null;

    if (!Array.isArray(sourcePositions) || sourcePositions.length < 9) {
      throw new Error(`${label} has no usable vertexpositions.`);
    }

    let positions;
    if (sourceIndexes && sourceIndexes.length >= 3) {
      positions = new Float32Array(sourceIndexes.length * 3);
      for (let i = 0; i < sourceIndexes.length; i += 1) {
        const sourceIndex = Math.max(0, Number(sourceIndexes[i]) || 0) * 3;
        const targetIndex = i * 3;
        positions[targetIndex] = finiteNumber(sourcePositions[sourceIndex]);
        positions[targetIndex + 1] = finiteNumber(sourcePositions[sourceIndex + 1]);
        positions[targetIndex + 2] = finiteNumber(sourcePositions[sourceIndex + 2]);
      }
    } else {
      positions = new Float32Array(sourcePositions.length);
      for (let i = 0; i < sourcePositions.length; i += 1) {
        positions[i] = finiteNumber(sourcePositions[i]);
      }
    }

    const triangleCount = Math.floor(positions.length / 9);
    const usableLength = triangleCount * 9;
    if (usableLength !== positions.length) {
      positions = positions.slice(0, usableLength);
    }

    if (triangleCount < 1) {
      throw new Error(`${label} has no complete triangles.`);
    }

    let normals = normalizeNormals(object.vertexnormals, sourceIndexes, positions.length);
    if (!normals) {
      normals = calculateFlatNormals(positions);
    } else if (normals.length !== positions.length) {
      normals = normals.slice(0, positions.length);
    }

    return {
      label,
      positions,
      normals,
      vertexCount: Math.floor(positions.length / 3),
      triangleCount,
      bounds: calculateBounds(positions),
      preview: null
    };
  }

  function normalizeNormals(sourceNormals, sourceIndexes, targetLength) {
    if (!Array.isArray(sourceNormals) || sourceNormals.length < 3) {
      return null;
    }

    if (sourceNormals.length >= targetLength) {
      const normals = new Float32Array(targetLength);
      for (let i = 0; i < targetLength; i += 1) {
        normals[i] = finiteNumber(sourceNormals[i]);
      }
      normalizeNormalTriplets(normals);
      return normals;
    }

    if (sourceIndexes && sourceNormals.length >= maxIndexValue(sourceIndexes) * 3 + 3) {
      const normals = new Float32Array(targetLength);
      for (let i = 0; i * 3 + 2 < targetLength && i < sourceIndexes.length; i += 1) {
        const sourceIndex = Math.max(0, Number(sourceIndexes[i]) || 0) * 3;
        const targetIndex = i * 3;
        normals[targetIndex] = finiteNumber(sourceNormals[sourceIndex]);
        normals[targetIndex + 1] = finiteNumber(sourceNormals[sourceIndex + 1]);
        normals[targetIndex + 2] = finiteNumber(sourceNormals[sourceIndex + 2]);
      }
      normalizeNormalTriplets(normals);
      return normals;
    }

    return null;
  }

  function normalizeNormalTriplets(normals) {
    for (let i = 0; i + 2 < normals.length; i += 3) {
      let x = normals[i];
      let y = normals[i + 1];
      let z = normals[i + 2];
      const length = Math.hypot(x, y, z) || 1;
      normals[i] = x / length;
      normals[i + 1] = y / length;
      normals[i + 2] = z / length;
    }
  }

  function maxIndexValue(indexes) {
    let max = 0;
    for (let i = 0; i < indexes.length; i += 1) {
      const value = Number(indexes[i]) || 0;
      if (value > max) {
        max = value;
      }
    }
    return max;
  }

  function calculateFlatNormals(positions) {
    const normals = new Float32Array(positions.length);

    for (let i = 0; i + 8 < positions.length; i += 9) {
      const ax = positions[i];
      const ay = positions[i + 1];
      const az = positions[i + 2];
      const bx = positions[i + 3];
      const by = positions[i + 4];
      const bz = positions[i + 5];
      const cx = positions[i + 6];
      const cy = positions[i + 7];
      const cz = positions[i + 8];

      const abx = bx - ax;
      const aby = by - ay;
      const abz = bz - az;
      const acx = cx - ax;
      const acy = cy - ay;
      const acz = cz - az;
      let nx = aby * acz - abz * acy;
      let ny = abz * acx - abx * acz;
      let nz = abx * acy - aby * acx;
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length;
      ny /= length;
      nz /= length;

      normals[i] = nx;
      normals[i + 1] = ny;
      normals[i + 2] = nz;
      normals[i + 3] = nx;
      normals[i + 4] = ny;
      normals[i + 5] = nz;
      normals[i + 6] = nx;
      normals[i + 7] = ny;
      normals[i + 8] = nz;
    }

    return normals;
  }

  function finalizeScene(scene) {
    scene.bounds = createEmptyBounds();

    for (const item of scene.renderItems) {
      includeTransformedBounds(scene.bounds, item.geometry.bounds, item.worldMatrix);
    }

    if (!boundsReady(scene.bounds)) {
      scene.bounds = {
        min: [-0.6, -0.6, -0.6],
        max: [0.6, 0.6, 0.6]
      };
    }

    const center = [
      (scene.bounds.min[0] + scene.bounds.max[0]) * 0.5,
      (scene.bounds.min[1] + scene.bounds.max[1]) * 0.5,
      (scene.bounds.min[2] + scene.bounds.max[2]) * 0.5
    ];
    const span = [
      scene.bounds.max[0] - scene.bounds.min[0],
      scene.bounds.max[1] - scene.bounds.min[1],
      scene.bounds.max[2] - scene.bounds.min[2]
    ];
    const maxSpan = Math.max(span[0], span[1], span[2], 0.0001);
    const fitScale = 1.35 / maxSpan;

    scene.span = span;
    scene.maxSpan = maxSpan;
    scene.radius = Math.max(0.7, Math.hypot(span[0], span[1], span[2]) * fitScale * 0.5);
    scene.centerScaleMatrix = makeCenterScaleMatrix(center, fitScale);

    for (const item of scene.renderItems) {
      multiply(item.normalizedMatrix, scene.centerScaleMatrix, item.worldMatrix);
    }
  }

  function chooseObjectColor(scene, object, inheritedColor) {
    if (Array.isArray(object.colors) && object.colors.length >= 3) {
      return normalizeColor(object.colors, inheritedColor);
    }

    if (typeof object.referenceobjectname === "string") {
      const referenceColor = scene.namedColors.get(object.referenceobjectname);
      if (referenceColor) {
        return referenceColor.slice();
      }
    }

    return normalizeColor(null, inheritedColor);
  }

  function normalizeColor(colors, fallback) {
    const base = Array.isArray(fallback) ? fallback : DEFAULT_COLOR;
    if (!Array.isArray(colors) || colors.length < 3) {
      return base.slice();
    }

    return [
      clampColor(colors[0]),
      clampColor(colors[1]),
      clampColor(colors[2]),
      colors.length > 3 ? clampColor(colors[3]) : 1
    ];
  }

  function clampColor(value) {
    if (!Number.isFinite(Number(value))) {
      return 1;
    }
    return Math.max(0, Math.min(1, Number(value)));
  }

  function exportUSDZ(scene, options) {
    if (!scene || !Array.isArray(scene.renderItems) || !scene.renderItems.length) {
      throw new Error("Load an MDJ model before exporting USDZ.");
    }

    const settings = Object.assign({
      fileName: scene.name || "model",
      units: "in",
      precision: 6,
      roughness: 0.68,
      metallic: 0.04
    }, options || {});

    const baseName = sanitizeFileBase(settings.fileName || scene.name || "model");
    const usdaName = `${baseName}.usda`;
    const usdzName = `${baseName}.usdz`;
    const usda = createUSDA(scene, settings);
    const usdaBytes = utf8Encode(usda);
    const bytes = createUSDZPackage(usdaName, usdaBytes);

    return {
      bytes,
      usda,
      usdaName,
      fileName: usdzName,
      mimeType: "model/vnd.usdz+zip"
    };
  }

  function createUSDA(scene, settings) {
    const unitScale = unitScaleFromSettings(settings);
    const precision = Math.max(3, Math.min(8, Number(settings.precision) || 6));
    const exportMatrix = makePhysicalScaleMatrix(scene.bounds, unitScale);
    const materials = [];
    const materialKeys = new Map();
    const parts = [];

    parts.push("#usda 1.0\n");
    parts.push("(\n");
    parts.push("    defaultPrim = \"Model\"\n");
    parts.push("    metersPerUnit = 1\n");
    parts.push("    upAxis = \"Y\"\n");
    parts.push(")\n\n");
    parts.push("def Xform \"Model\" (\n");
    parts.push("    kind = \"component\"\n");
    parts.push(")\n");
    parts.push("{\n");
    parts.push(`    custom int sourceMeshes = ${scene.meshCount}\n`);
    parts.push(`    custom int sourceRenderMeshes = ${scene.renderItems.length}\n`);
    parts.push(`    custom string sourceModel = ${quoteUSDString(scene.name || "MDJ Model")}\n`);
    parts.push(`    custom string sourceUnits = ${quoteUSDString(settings.units || "in")}\n`);
    parts.push(`    custom double sourceSpanX = ${formatNumber(scene.span[0], precision)}\n`);
    parts.push(`    custom double sourceSpanY = ${formatNumber(scene.span[1], precision)}\n`);
    parts.push(`    custom double sourceSpanZ = ${formatNumber(scene.span[2], precision)}\n`);
    parts.push(`    custom int sourceTriangles = ${scene.triangleCount}\n`);
    parts.push(`    custom int unresolvedReferences = ${scene.unresolvedReferenceCount || 0}\n\n`);
    parts.push("    def Scope \"Geometry\"\n");
    parts.push("    {\n");

    for (let i = 0; i < scene.renderItems.length; i += 1) {
      const item = scene.renderItems[i];
      const materialName = materialForColor(item.color, materials, materialKeys);
      const meshName = makeMeshPrimName(i + 1, item.name || item.geometry.label);
      const modelMatrix = mat4();
      multiply(modelMatrix, exportMatrix, item.worldMatrix);

      parts.push(`        def Mesh "${meshName}" (\n`);
      parts.push("            prepend apiSchemas = [\"MaterialBindingAPI\"]\n");
      parts.push("        )\n");
      parts.push("        {\n");
      parts.push("            uniform bool doubleSided = 1\n");
      appendRepeatedIntArray(parts, "int[] faceVertexCounts", 3, item.geometry.triangleCount, "            ");
      appendIntSequence(parts, "int[] faceVertexIndices", item.geometry.vertexCount, "            ");
      parts.push(`            rel material:binding = </Model/Materials/${materialName}>\n`);
      appendTransformedPointArray(parts, item.geometry.positions, modelMatrix, precision, "            ");
      parts.push("            uniform token subdivisionScheme = \"none\"\n");
      parts.push("        }\n\n");
    }

    parts.push("    }\n\n");
    parts.push("    def Scope \"Materials\"\n");
    parts.push("    {\n");

    for (const material of materials) {
      parts.push(`        def Material "${material.name}"\n`);
      parts.push("        {\n");
      parts.push(`            token outputs:surface.connect = </Model/Materials/${material.name}/PreviewSurface.outputs:surface>\n\n`);
      parts.push("            def Shader \"PreviewSurface\"\n");
      parts.push("            {\n");
      parts.push("                uniform token info:id = \"UsdPreviewSurface\"\n");
      parts.push(`                color3f inputs:diffuseColor = (${formatNumber(material.color[0], 3)}, ${formatNumber(material.color[1], 3)}, ${formatNumber(material.color[2], 3)})\n`);
      parts.push(`                float inputs:metallic = ${formatNumber(settings.metallic, 3)}\n`);
      parts.push(`                float inputs:opacity = ${formatNumber(material.color[3], 3)}\n`);
      parts.push(`                float inputs:roughness = ${formatNumber(settings.roughness, 3)}\n`);
      parts.push("                token outputs:surface\n");
      parts.push("            }\n");
      parts.push("        }\n\n");
    }

    parts.push("    }\n");
    parts.push("}\n");

    return parts.join("");
  }

  function materialForColor(color, materials, materialKeys) {
    const normalized = normalizeColor(color, DEFAULT_COLOR);
    const key = normalized.map((value) => Math.round(value * 1000)).join("_");
    if (materialKeys.has(key)) {
      return materialKeys.get(key);
    }

    const name = `Material_${String(materials.length + 1).padStart(3, "0")}`;
    materials.push({ name, color: normalized });
    materialKeys.set(key, name);
    return name;
  }

  function appendTransformedPointArray(parts, values, matrix, precision, indent) {
    parts.push(`${indent}point3f[] points = [`);
    const chunk = [];
    const flush = () => {
      if (chunk.length) {
        parts.push(chunk.join(", "));
        chunk.length = 0;
      }
    };

    for (let i = 0; i + 2 < values.length; i += 3) {
      const x = matrix[0] * values[i] + matrix[4] * values[i + 1] + matrix[8] * values[i + 2] + matrix[12];
      const y = matrix[1] * values[i] + matrix[5] * values[i + 1] + matrix[9] * values[i + 2] + matrix[13];
      const z = matrix[2] * values[i] + matrix[6] * values[i + 1] + matrix[10] * values[i + 2] + matrix[14];
      chunk.push(`(${formatNumber(x, precision)}, ${formatNumber(y, precision)}, ${formatNumber(z, precision)})`);
      if (chunk.length >= 180 && i + 3 < values.length) {
        flush();
        parts.push(",\n");
        parts.push(`${indent}    `);
      }
    }

    flush();
    parts.push("]\n");
  }

  function appendRepeatedIntArray(parts, label, value, count, indent) {
    parts.push(`${indent}${label} = [`);
    const chunk = [];
    for (let i = 0; i < count; i += 1) {
      chunk.push(String(value));
      if (chunk.length >= 320) {
        parts.push(chunk.join(", "));
        chunk.length = 0;
        if (i + 1 < count) {
          parts.push(",\n");
          parts.push(`${indent}    `);
        }
      }
    }
    if (chunk.length) {
      parts.push(chunk.join(", "));
    }
    parts.push("]\n");
  }

  function appendIntSequence(parts, label, count, indent) {
    parts.push(`${indent}${label} = [`);
    const chunk = [];
    for (let i = 0; i < count; i += 1) {
      chunk.push(String(i));
      if (chunk.length >= 320) {
        parts.push(chunk.join(", "));
        chunk.length = 0;
        if (i + 1 < count) {
          parts.push(",\n");
          parts.push(`${indent}    `);
        }
      }
    }
    if (chunk.length) {
      parts.push(chunk.join(", "));
    }
    parts.push("]\n");
  }

  function createUSDZPackage(fileName, fileBytes) {
    const nameBytes = asciiEncode(fileName);
    const extra = createAlignmentExtra(30 + nameBytes.length);
    const crc = crc32(fileBytes);
    const now = new Date();
    const dos = dosDateTime(now);
    const localHeaderLength = 30 + nameBytes.length + extra.length;
    const centralDirectoryOffset = localHeaderLength + fileBytes.length;
    const centralDirectoryLength = 46 + nameBytes.length + extra.length;
    const totalLength = centralDirectoryOffset + centralDirectoryLength + 22;
    const out = new Uint8Array(totalLength);
    const view = new DataView(out.buffer);
    let offset = 0;

    view.setUint32(offset, 0x04034b50, true); offset += 4;
    view.setUint16(offset, 10, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, dos.time, true); offset += 2;
    view.setUint16(offset, dos.date, true); offset += 2;
    view.setUint32(offset, crc, true); offset += 4;
    view.setUint32(offset, fileBytes.length, true); offset += 4;
    view.setUint32(offset, fileBytes.length, true); offset += 4;
    view.setUint16(offset, nameBytes.length, true); offset += 2;
    view.setUint16(offset, extra.length, true); offset += 2;
    out.set(nameBytes, offset); offset += nameBytes.length;
    out.set(extra, offset); offset += extra.length;
    out.set(fileBytes, offset); offset += fileBytes.length;

    view.setUint32(offset, 0x02014b50, true); offset += 4;
    view.setUint16(offset, 10, true); offset += 2;
    view.setUint16(offset, 10, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, dos.time, true); offset += 2;
    view.setUint16(offset, dos.date, true); offset += 2;
    view.setUint32(offset, crc, true); offset += 4;
    view.setUint32(offset, fileBytes.length, true); offset += 4;
    view.setUint32(offset, fileBytes.length, true); offset += 4;
    view.setUint16(offset, nameBytes.length, true); offset += 2;
    view.setUint16(offset, extra.length, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, 0, true); offset += 4;
    out.set(nameBytes, offset); offset += nameBytes.length;
    out.set(extra, offset); offset += extra.length;

    view.setUint32(offset, 0x06054b50, true); offset += 4;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint32(offset, centralDirectoryLength, true); offset += 4;
    view.setUint32(offset, centralDirectoryOffset, true); offset += 4;
    view.setUint16(offset, 0, true);

    return out;
  }

  function createAlignmentExtra(baseOffset) {
    const padding = (64 - ((baseOffset + 4) % 64)) % 64;
    const extra = new Uint8Array(4 + padding);
    const view = new DataView(extra.buffer);
    view.setUint16(0, 0x1986, true);
    view.setUint16(2, padding, true);
    return extra;
  }

  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) {
          c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crcTable[i] = c >>> 0;
      }
    }

    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);
    return {
      time: (hours << 11) | (minutes << 5) | seconds,
      date: ((year - 1980) << 9) | (month << 5) | day
    };
  }

  function createEmptyBounds() {
    return {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity]
    };
  }

  function boundsReady(bounds) {
    return Number.isFinite(bounds.min[0]) && Number.isFinite(bounds.max[0]);
  }

  function includePoint(bounds, x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return;
    }
    bounds.min[0] = Math.min(bounds.min[0], x);
    bounds.min[1] = Math.min(bounds.min[1], y);
    bounds.min[2] = Math.min(bounds.min[2], z);
    bounds.max[0] = Math.max(bounds.max[0], x);
    bounds.max[1] = Math.max(bounds.max[1], y);
    bounds.max[2] = Math.max(bounds.max[2], z);
  }

  function includeTransformedBounds(targetBounds, sourceBounds, matrix) {
    const min = sourceBounds.min;
    const max = sourceBounds.max;
    const corners = [
      [min[0], min[1], min[2]], [max[0], min[1], min[2]],
      [min[0], max[1], min[2]], [max[0], max[1], min[2]],
      [min[0], min[1], max[2]], [max[0], min[1], max[2]],
      [min[0], max[1], max[2]], [max[0], max[1], max[2]]
    ];

    for (const corner of corners) {
      includePoint(
        targetBounds,
        matrix[0] * corner[0] + matrix[4] * corner[1] + matrix[8] * corner[2] + matrix[12],
        matrix[1] * corner[0] + matrix[5] * corner[1] + matrix[9] * corner[2] + matrix[13],
        matrix[2] * corner[0] + matrix[6] * corner[1] + matrix[10] * corner[2] + matrix[14]
      );
    }
  }

  function calculateBounds(positions) {
    const bounds = createEmptyBounds();
    for (let i = 0; i + 2 < positions.length; i += 3) {
      includePoint(bounds, positions[i], positions[i + 1], positions[i + 2]);
    }
    return bounds;
  }

  function matrixFromObject(object) {
    if (Array.isArray(object.transformation) && object.transformation.length >= 16) {
      const out = new Float64Array(16);
      for (let i = 0; i < 16; i += 1) {
        out[i] = finiteNumber(object.transformation[i], i % 5 === 0 ? 1 : 0);
      }
      return out;
    }

    const out = copyMatrix(IDENTITY);
    if (object.transform && typeof object.transform === "object") {
      const transform = object.transform;
      translate(out, out, [
        Number(transform.positionx) || 0,
        Number(transform.positiony) || 0,
        Number(transform.positionz) || 0
      ]);
      rotateX(out, out, ((Number(transform.anglex) || 0) * Math.PI) / 180);
      rotateY(out, out, ((Number(transform.angley) || 0) * Math.PI) / 180);
      rotateZ(out, out, ((Number(transform.anglez) || 0) * Math.PI) / 180);
    }
    return out;
  }

  function makeCenterScaleMatrix(center, scale) {
    return new Float64Array([
      scale, 0, 0, 0,
      0, scale, 0, 0,
      0, 0, scale, 0,
      -center[0] * scale, -center[1] * scale, -center[2] * scale, 1
    ]);
  }

  function makePhysicalScaleMatrix(bounds, scale) {
    const centerX = (bounds.min[0] + bounds.max[0]) * 0.5;
    const centerZ = (bounds.min[2] + bounds.max[2]) * 0.5;
    return new Float64Array([
      scale, 0, 0, 0,
      0, scale, 0, 0,
      0, 0, scale, 0,
      -centerX * scale, -bounds.min[1] * scale, -centerZ * scale, 1
    ]);
  }

  function mat4() {
    return copyMatrix(IDENTITY);
  }

  function copyMatrix(matrix) {
    return new Float64Array(matrix);
  }

  function identity(out) {
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  }

  function multiply(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    return out;
  }

  function perspective(out, fovy, aspect, near, far) {
    const f = 1.0 / Math.tan(fovy / 2);
    out[0] = f / aspect;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = f;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[11] = -1;
    out[12] = 0;
    out[13] = 0;
    out[15] = 0;

    const nf = 1 / (near - far);
    out[10] = (far + near) * nf;
    out[14] = 2 * far * near * nf;
    return out;
  }

  function lookAt(out, eye, center, up) {
    let zx = eye[0] - center[0];
    let zy = eye[1] - center[1];
    let zz = eye[2] - center[2];
    let len = Math.hypot(zx, zy, zz);
    if (len === 0) {
      zz = 1;
    } else {
      zx /= len;
      zy /= len;
      zz /= len;
    }

    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz);
    if (len === 0) {
      xx = 1;
    } else {
      xx /= len;
      xy /= len;
      xz /= len;
    }

    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    out[0] = xx;
    out[1] = yx;
    out[2] = zx;
    out[3] = 0;
    out[4] = xy;
    out[5] = yy;
    out[6] = zy;
    out[7] = 0;
    out[8] = xz;
    out[9] = yz;
    out[10] = zz;
    out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }

  function translate(out, a, vector) {
    const x = vector[0], y = vector[1], z = vector[2];

    if (out !== a) {
      out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
      out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
      out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
    }

    out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
    out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
    out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
    out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
    return out;
  }

  function rotateX(out, a, radians) {
    const s = Math.sin(radians);
    const c = Math.cos(radians);
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];

    if (out !== a) {
      out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }

    out[4] = a10 * c + a20 * s;
    out[5] = a11 * c + a21 * s;
    out[6] = a12 * c + a22 * s;
    out[7] = a13 * c + a23 * s;
    out[8] = a20 * c - a10 * s;
    out[9] = a21 * c - a11 * s;
    out[10] = a22 * c - a12 * s;
    out[11] = a23 * c - a13 * s;
    return out;
  }

  function rotateY(out, a, radians) {
    const s = Math.sin(radians);
    const c = Math.cos(radians);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];

    if (out !== a) {
      out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }

    out[0] = a00 * c - a20 * s;
    out[1] = a01 * c - a21 * s;
    out[2] = a02 * c - a22 * s;
    out[3] = a03 * c - a23 * s;
    out[8] = a00 * s + a20 * c;
    out[9] = a01 * s + a21 * c;
    out[10] = a02 * s + a22 * c;
    out[11] = a03 * s + a23 * c;
    return out;
  }

  function rotateZ(out, a, radians) {
    const s = Math.sin(radians);
    const c = Math.cos(radians);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];

    if (out !== a) {
      out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }

    out[0] = a00 * c + a10 * s;
    out[1] = a01 * c + a11 * s;
    out[2] = a02 * c + a12 * s;
    out[3] = a03 * c + a13 * s;
    out[4] = a10 * c - a00 * s;
    out[5] = a11 * c - a01 * s;
    out[6] = a12 * c - a02 * s;
    out[7] = a13 * c - a03 * s;
    return out;
  }

  function unitScaleFromSettings(settings) {
    if (Number.isFinite(Number(settings.unitScale)) && Number(settings.unitScale) > 0) {
      return Number(settings.unitScale);
    }
    return UNIT_SCALES[settings.units] || UNIT_SCALES.in;
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : (fallback || 0);
  }

  function formatNumber(value, precision) {
    const number = Math.abs(value) < 1e-12 ? 0 : finiteNumber(value);
    let text = number.toFixed(precision);
    text = text.replace(/\.?0+$/, "");
    if (text === "-0") {
      return "0";
    }
    return text || "0";
  }

  function quoteUSDString(value) {
    return JSON.stringify(String(value == null ? "" : value));
  }

  function makeMeshPrimName(index, name) {
    const safe = sanitizePrimName(name || "Part").slice(0, 88) || "Part";
    return `Mesh_${String(index).padStart(3, "0")}_${safe}`;
  }

  function sanitizePrimName(value) {
    let text = String(value || "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (!text || !/^[A-Za-z_]/.test(text)) {
      text = `Part_${text}`;
    }
    return text;
  }

  function sanitizeFileBase(value) {
    let text = String(value || "model").replace(/\.[A-Za-z0-9]+$/, "");
    text = text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return text || "model";
  }

  function utf8Encode(text) {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(text);
    }
    const encoded = unescape(encodeURIComponent(text));
    const bytes = new Uint8Array(encoded.length);
    for (let i = 0; i < encoded.length; i += 1) {
      bytes[i] = encoded.charCodeAt(i);
    }
    return bytes;
  }

  function asciiEncode(text) {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      bytes[i] = code > 127 ? 95 : code;
    }
    return bytes;
  }

  return {
    DEFAULT_COLOR,
    UNIT_SCALES,
    parseMDJText,
    extractMDJRoots,
    buildMDJScene,
    exportUSDZ,
    createUSDA,
    createUSDZPackage,
    math: {
      mat4,
      copyMatrix,
      identity,
      multiply,
      perspective,
      lookAt
    },
    formatNumber,
    sanitizeFileBase
  };
});
