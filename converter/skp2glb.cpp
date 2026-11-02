// skp2glb: reads a .skp with the SketchUp C SDK and writes a GLB (meters, Y-up).
// Exports geometry, material colors and textures, and material inheritance from groups and
// instances. Smooth shading across soft/smooth edges comes from the SDK's mesh helper, whose
// normals already account for it (measured: averaging them again changed almost nothing).
#include <SketchUpAPI/common.h>
#include <SketchUpAPI/initialize.h>
#include <SketchUpAPI/model/component_definition.h>
#include <SketchUpAPI/model/component_instance.h>
#include <SketchUpAPI/model/drawing_element.h>
#include <SketchUpAPI/model/entities.h>
#include <SketchUpAPI/model/face.h>
#include <SketchUpAPI/model/group.h>
#include <SketchUpAPI/model/image_rep.h>
#include <SketchUpAPI/model/layer.h>
#include <SketchUpAPI/model/texture.h>
#include <SketchUpAPI/model/uv_helper.h>
#include <SketchUpAPI/model/material.h>
#include <SketchUpAPI/model/mesh_helper.h>
#include <SketchUpAPI/model/model.h>
#include <SketchUpAPI/unicodestring.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr double kInchToMeter = 0.0254;

using Mat4 = std::array<double, 16>;  // column-major, as SUTransformation

Mat4 Identity() {
  return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
}

Mat4 Multiply(const Mat4& a, const Mat4& b) {
  Mat4 r{};
  for (int col = 0; col < 4; col++)
    for (int row = 0; row < 4; row++) {
      double s = 0;
      for (int k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      r[col * 4 + row] = s;
    }
  return r;
}

double Determinant3(const Mat4& m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) +
         m[8] * (m[1] * m[6] - m[5] * m[2]);
}

struct Material {
  float rgba[4] = {0.7f, 0.7f, 0.7f, 1.0f};  // linear
  std::string name = "default";
};

struct Bucket {
  std::string tag;  // the SketchUp tag (layer) the faces are on; each tag becomes its own node
  Material material;
  std::vector<float> positions, normals, uvs;
  std::vector<uint32_t> indices;
  std::vector<uint8_t> png;  // non-empty: material is textured and uvs are filled
  double tileW = 1, tileH = 1;  // texture size in model units (inches), for planar mapping
};

// Saves a material's texture as PNG and returns the file bytes (empty on failure).
std::vector<uint8_t> ExtractTexturePng(SUMaterialRef mat, size_t serial) {
  SUTextureRef tex = SU_INVALID;
  if (SUMaterialGetTexture(mat, &tex) != SU_ERROR_NONE) return {};
  SUImageRepRef rep = SU_INVALID;
  SUImageRepCreate(&rep);
  std::vector<uint8_t> bytes;
  if (SUTextureGetImageRep(tex, &rep) == SU_ERROR_NONE) {
    auto path = std::filesystem::temp_directory_path() / ("skp2glb_tex_" + std::to_string(serial) + ".png");
    if (SUImageRepSaveToFile(rep, path.c_str()) == SU_ERROR_NONE) {
      std::ifstream in(path, std::ios::binary);
      bytes.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    }
    std::error_code ec;
    std::filesystem::remove(path, ec);
  }
  SUImageRepRelease(&rep);
  return bytes;
}

float SrgbToLinear(float c) {
  return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}

std::string ToUtf8(SUStringRef s) {
  size_t len = 0;
  SUStringGetUTF8Length(s, &len);
  std::string out(len, '\0');
  size_t written = 0;
  SUStringGetUTF8(s, len + 1, out.data(), &written);
  return out;
}

struct Exporter {
  std::map<std::string, Bucket> buckets;
  size_t skippedHidden = 0;

  // SketchUp (Z-up, inches) -> glTF (Y-up, meters): (x, y, z) -> (x, z, -y)
  static void Emit(Bucket& b, const Mat4& m, const SUPoint3D& p, const SUVector3D& n) {
    double x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
    double y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
    double z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
    double nx = m[0] * n.x + m[4] * n.y + m[8] * n.z;
    double ny = m[1] * n.x + m[5] * n.y + m[9] * n.z;
    double nz = m[2] * n.x + m[6] * n.y + m[10] * n.z;
    double nl = std::sqrt(nx * nx + ny * ny + nz * nz);
    if (nl > 0) nx /= nl, ny /= nl, nz /= nl;
    b.positions.insert(b.positions.end(), {(float)(x * kInchToMeter), (float)(z * kInchToMeter),
                                           (float)(-y * kInchToMeter)});
    b.normals.insert(b.normals.end(), {(float)nx, (float)nz, (float)-ny});
  }

  Bucket& BucketFor(SUMaterialRef mat, const std::string& tag) {
    std::string key = "default";
    Material info;
    if (SUIsValid(mat)) {
      SUStringRef name = SU_INVALID;
      SUStringCreate(&name);
      SUMaterialGetNameLegacyBehavior(mat, &name);
      key = ToUtf8(name);
      SUStringRelease(&name);
      info.name = key;
      SUColor c;
      if (SUMaterialGetColor(mat, &c) == SU_ERROR_NONE) {
        info.rgba[0] = SrgbToLinear(c.red / 255.f);
        info.rgba[1] = SrgbToLinear(c.green / 255.f);
        info.rgba[2] = SrgbToLinear(c.blue / 255.f);
      }
      double alpha = 1;
      if (SUMaterialGetOpacity(mat, &alpha) == SU_ERROR_NONE) info.rgba[3] = (float)alpha;
    }
    auto [it, inserted] = buckets.try_emplace(tag + '\x1f' + key);
    if (inserted) {
      it->second.tag = tag;
      it->second.material = info;
      if (SUIsValid(mat)) {
        SUMaterialType type = SUMaterialType_Colored;
        SUMaterialGetType(mat, &type);
        if (type != SUMaterialType_Colored) {
          it->second.png = ExtractTexturePng(mat, buckets.size());
          SUTextureRef tex = SU_INVALID;
          size_t w = 0, h = 0;
          double sScale = 1, tScale = 1;
          if (SUMaterialGetTexture(mat, &tex) == SU_ERROR_NONE &&
              SUTextureGetDimensions(tex, &w, &h, &sScale, &tScale) == SU_ERROR_NONE) {
            it->second.tileW = std::max(1e-6, w * sScale);
            it->second.tileH = std::max(1e-6, h * tScale);
          }
          // Texture supplies the color; v1 ignores colorize tinting.
          if (!it->second.png.empty()) it->second.material.rgba[0] = it->second.material.rgba[1] = it->second.material.rgba[2] = 1.0f;
        }
      }
    }
    return it->second;
  }

  bool IsHidden(SUDrawingElementRef el) {
    bool hidden = false;
    SUDrawingElementGetHidden(el, &hidden);
    if (hidden) return true;
    SULayerRef layer = SU_INVALID;
    if (SUDrawingElementGetLayer(el, &layer) == SU_ERROR_NONE && SUIsValid(layer)) {
      bool visible = true;
      SULayerGetVisibility(layer, &visible);
      if (!visible) return true;
    }
    return false;
  }

  // The tag an element is on: its own, or the parent's when it has none of its own (SketchUp's default tag, Untagged).
  static std::string TagOf(SUDrawingElementRef el, const std::string& inherited) {
    SULayerRef layer = SU_INVALID;
    if (SUDrawingElementGetLayer(el, &layer) != SU_ERROR_NONE || !SUIsValid(layer)) return inherited;
    SUStringRef name = SU_INVALID;
    SUStringCreate(&name);
    SULayerGetName(layer, &name);
    std::string tag = ToUtf8(name);
    SUStringRelease(&name);
    return tag.empty() || tag == "Layer0" || tag == "Untagged" ? inherited : tag;
  }

  void AddFace(SUFaceRef face, const Mat4& m, SUMaterialRef inherited, const std::string& inheritedTag) {
    if (IsHidden(SUFaceToDrawingElement(face))) {
      skippedHidden++;
      return;
    }
    SUMaterialRef mat = SU_INVALID;
    bool ownMaterial = SUFaceGetFrontMaterial(face, &mat) == SU_ERROR_NONE && SUIsValid(mat);
    if (!ownMaterial) mat = inherited;  // unpainted faces take the parent's material
    Bucket& b = BucketFor(mat, TagOf(SUFaceToDrawingElement(face), inheritedTag));

    SUMeshHelperRef mesh = SU_INVALID;
    if (SUMeshHelperCreate(&mesh, face) != SU_ERROR_NONE) return;
    size_t nv = 0, nt = 0;
    SUMeshHelperGetNumVertices(mesh, &nv);
    SUMeshHelperGetNumTriangles(mesh, &nt);
    std::vector<SUPoint3D> pts(nv);
    std::vector<SUVector3D> nrm(nv);
    std::vector<size_t> idx(nt * 3);
    size_t got = 0;
    SUMeshHelperGetVertices(mesh, nv, pts.data(), &got);
    SUMeshHelperGetNormals(mesh, nv, nrm.data(), &got);
    SUMeshHelperGetVertexIndices(mesh, nt * 3, idx.data(), &got);

    if (!b.png.empty()) {
      SUUVHelperRef uvh = SU_INVALID;
      bool haveUv =
          ownMaterial && SUFaceGetUVHelper(face, true, false, SU_INVALID, &uvh) == SU_ERROR_NONE;
      for (size_t i = 0; i < nv; i++) {
        double u, v;
        if (haveUv) {
          SUUVQ uvq = {0, 0, 1};
          SUUVHelperGetFrontUVQ(uvh, &pts[i], &uvq);
          double q = uvq.q != 0 ? uvq.q : 1;
          u = uvq.u / q, v = uvq.v / q;
        } else {
          // Inherited texture: project along the dominant normal axis, in the face's local space.
          double ax = std::abs(nrm[i].x), ay = std::abs(nrm[i].y), az = std::abs(nrm[i].z);
          double pu, pv;
          if (az >= ax && az >= ay) pu = pts[i].x, pv = pts[i].y;
          else if (ay >= ax) pu = pts[i].x, pv = pts[i].z;
          else pu = pts[i].y, pv = pts[i].z;
          u = pu / b.tileW, v = pv / b.tileH;
        }
        // SketchUp v points up, glTF v points down.
        b.uvs.insert(b.uvs.end(), {(float)u, (float)(1.0 - v)});
      }
      if (haveUv) SUUVHelperRelease(&uvh);
    }

    uint32_t base = (uint32_t)(b.positions.size() / 3);
    for (size_t i = 0; i < nv; i++) Emit(b, m, pts[i], nrm[i]);
    bool mirrored = Determinant3(m) < 0;  // mirroring flips winding
    for (size_t t = 0; t < nt; t++) {
      uint32_t a = base + (uint32_t)idx[t * 3], bb = base + (uint32_t)idx[t * 3 + 1],
               c = base + (uint32_t)idx[t * 3 + 2];
      if (mirrored) std::swap(bb, c);
      b.indices.insert(b.indices.end(), {a, bb, c});
    }
    SUMeshHelperRelease(&mesh);
  }

  static SUMaterialRef MaterialOf(SUDrawingElementRef el, SUMaterialRef fallback) {
    SUMaterialRef mat = SU_INVALID;
    return SUDrawingElementGetMaterial(el, &mat) == SU_ERROR_NONE && SUIsValid(mat) ? mat : fallback;
  }

  void Walk(SUEntitiesRef entities, const Mat4& m, SUMaterialRef inherited, const std::string& tag) {
    size_t n = 0;
    SUEntitiesGetNumFaces(entities, &n);
    if (n > 0) {
      std::vector<SUFaceRef> faces(n);
      SUEntitiesGetFaces(entities, n, faces.data(), &n);
      for (size_t i = 0; i < n; i++) AddFace(faces[i], m, inherited, tag);
    }

    SUEntitiesGetNumGroups(entities, &n);
    if (n > 0) {
      std::vector<SUGroupRef> groups(n);
      SUEntitiesGetGroups(entities, n, groups.data(), &n);
      for (size_t i = 0; i < n; i++) {
        if (IsHidden(SUGroupToDrawingElement(groups[i]))) {
          skippedHidden++;
          continue;
        }
        SUMaterialRef inheritedChild = MaterialOf(SUGroupToDrawingElement(groups[i]), inherited);
        SUTransformation t;
        SUGroupGetTransform(groups[i], &t);
        SUEntitiesRef child = SU_INVALID;
        SUGroupGetEntities(groups[i], &child);
        Walk(child, Multiply(m, ToMat(t)), inheritedChild, TagOf(SUGroupToDrawingElement(groups[i]), tag));
      }
    }

    SUEntitiesGetNumInstances(entities, &n);
    if (n > 0) {
      std::vector<SUComponentInstanceRef> inst(n);
      SUEntitiesGetInstances(entities, n, inst.data(), &n);
      for (size_t i = 0; i < n; i++) {
        if (IsHidden(SUComponentInstanceToDrawingElement(inst[i]))) {
          skippedHidden++;
          continue;
        }
        SUMaterialRef inheritedChild =
            MaterialOf(SUComponentInstanceToDrawingElement(inst[i]), inherited);
        SUTransformation t;
        SUComponentInstanceGetTransform(inst[i], &t);
        SUComponentDefinitionRef def = SU_INVALID;
        SUComponentInstanceGetDefinition(inst[i], &def);
        SUEntitiesRef child = SU_INVALID;
        SUComponentDefinitionGetEntities(def, &child);
        Walk(child, Multiply(m, ToMat(t)), inheritedChild, TagOf(SUComponentInstanceToDrawingElement(inst[i]), tag));
      }
    }
  }

  static Mat4 ToMat(const SUTransformation& t) {
    Mat4 m;
    for (int i = 0; i < 16; i++) m[i] = t.values[i];
    return m;
  }
};

// --- GLB writing -----------------------------------------------------------

void Pad(std::vector<uint8_t>& v, uint8_t fill) {
  while (v.size() % 4) v.push_back(fill);
}

template <typename T>
size_t AppendBytes(std::vector<uint8_t>& bin, const std::vector<T>& data) {
  Pad(bin, 0);
  size_t offset = bin.size();
  const uint8_t* p = reinterpret_cast<const uint8_t*>(data.data());
  bin.insert(bin.end(), p, p + data.size() * sizeof(T));
  return offset;
}

std::string Escape(const std::string& s) {
  std::string o;
  for (char c : s) {
    if (c == '"' || c == '\\') o += '\\';
    if ((unsigned char)c < 0x20) continue;
    o += c;
  }
  return o;
}

bool WriteGlb(const std::string& path, std::map<std::string, Bucket>& buckets) {
  std::vector<uint8_t> bin;
  std::ostringstream views, accessors, mats, images, textures;
  int view = 0, acc = 0, matIndex = 0, texCount = 0;
  bool firstMat = true, firstView = true, firstAcc = true;
  // One mesh (and node) per tag, so the viewer can show and hide a tag; buckets are ordered by tag.
  std::vector<std::string> tags;
  std::vector<std::ostringstream> meshPrims;
  std::map<std::string, int> textureOfMaterial;  // a material used by several tags stores its image once

  auto addView = [&](size_t off, size_t len, int target) {
    if (!firstView) views << ",";
    firstView = false;
    views << "{\"buffer\":0,\"byteOffset\":" << off << ",\"byteLength\":" << len;
    if (target) views << ",\"target\":" << target;
    views << "}";
    return view++;
  };
  auto addAcc = [&](int bufView, int comp, size_t count, const char* type, const std::string& extra) {
    if (!firstAcc) accessors << ",";
    firstAcc = false;
    accessors << "{\"bufferView\":" << bufView << ",\"componentType\":" << comp
              << ",\"count\":" << count << ",\"type\":\"" << type << "\"" << extra << "}";
    return acc++;
  };

  for (auto& [key, b] : buckets) {
    if (b.indices.empty()) continue;
    float mn[3] = {1e30f, 1e30f, 1e30f}, mx[3] = {-1e30f, -1e30f, -1e30f};
    for (size_t i = 0; i < b.positions.size(); i += 3)
      for (int k = 0; k < 3; k++) {
        mn[k] = std::min(mn[k], b.positions[i + k]);
        mx[k] = std::max(mx[k], b.positions[i + k]);
      }
    size_t vc = b.positions.size() / 3;
    int vp = addView(AppendBytes(bin, b.positions), b.positions.size() * 4, 34962);
    int vn = addView(AppendBytes(bin, b.normals), b.normals.size() * 4, 34962);
    int vi = addView(AppendBytes(bin, b.indices), b.indices.size() * 4, 34963);
    std::ostringstream ext;
    ext << ",\"min\":[" << mn[0] << "," << mn[1] << "," << mn[2] << "],\"max\":[" << mx[0] << ","
        << mx[1] << "," << mx[2] << "]";
    int ap = addAcc(vp, 5126, vc, "VEC3", ext.str());
    int an = addAcc(vn, 5126, vc, "VEC3", "");
    int ai = addAcc(vi, 5125, b.indices.size(), "SCALAR", "");

    bool textured = !b.png.empty() && b.uvs.size() == vc * 2;
    int auv = -1;
    int texIndex = -1;
    if (textured) {
      int vu = addView(AppendBytes(bin, b.uvs), b.uvs.size() * 4, 34962);
      auv = addAcc(vu, 5126, vc, "VEC2", "");
      auto known = textureOfMaterial.find(b.material.name);
      if (known != textureOfMaterial.end()) {
        texIndex = known->second;
      } else {
        int vimg = addView(AppendBytes(bin, b.png), b.png.size(), 0);
        if (texCount) { images << ","; textures << ","; }
        images << "{\"bufferView\":" << vimg << ",\"mimeType\":\"image/png\"}";
        textures << "{\"sampler\":0,\"source\":" << texCount << "}";
        texIndex = texCount++;
        textureOfMaterial[b.material.name] = texIndex;
      }
    }

    if (tags.empty() || tags.back() != b.tag) {
      tags.push_back(b.tag);
      meshPrims.emplace_back();
    }
    std::ostringstream& prims = meshPrims.back();
    if (prims.tellp() > 0) prims << ",";
    prims << "{\"attributes\":{\"POSITION\":" << ap << ",\"NORMAL\":" << an;
    if (textured) prims << ",\"TEXCOORD_0\":" << auv;
    prims << "},\"indices\":" << ai << ",\"material\":" << matIndex << "}";
    if (!firstMat) mats << ",";
    firstMat = false;
    const float* c = b.material.rgba;
    mats << "{\"name\":\"" << Escape(b.material.name) << "\",\"doubleSided\":true,"
         << "\"alphaMode\":\"" << (c[3] < 0.999f ? "BLEND" : "OPAQUE") << "\","
         << "\"pbrMetallicRoughness\":{\"baseColorFactor\":[" << c[0] << "," << c[1] << ","
         << c[2] << "," << c[3] << "]";
    if (textured) mats << ",\"baseColorTexture\":{\"index\":" << texIndex << "}";
    mats << ",\"metallicFactor\":0,\"roughnessFactor\":0.9}}";
    matIndex++;
  }

  std::ostringstream nodes, nodeList, meshes;
  for (size_t i = 0; i < tags.size(); i++) {
    if (i) { nodes << ","; nodeList << ","; meshes << ","; }
    nodes << "{\"mesh\":" << i << ",\"name\":\"tag:" << Escape(tags[i]) << "\"}";
    nodeList << i;
    meshes << "{\"primitives\":[" << meshPrims[i].str() << "]}";
  }

  std::ostringstream json;
  json << "{\"asset\":{\"version\":\"2.0\",\"generator\":\"preflight skp2glb\"},"
       << "\"scene\":0,\"scenes\":[{\"nodes\":[" << nodeList.str() << "]}],\"nodes\":[" << nodes.str() << "],"
       << "\"meshes\":[" << meshes.str() << "],"
       << "\"materials\":[" << mats.str() << "],"
       << "\"samplers\":[{\"magFilter\":9729,\"minFilter\":9987,\"wrapS\":10497,\"wrapT\":10497}],"
       << "\"images\":[" << images.str() << "],\"textures\":[" << textures.str() << "],"
       << "\"accessors\":[" << accessors.str() << "],"
       << "\"bufferViews\":[" << views.str() << "],"
       << "\"buffers\":[{\"byteLength\":" << bin.size() << "}]}";
  std::string js = json.str();
  while (js.size() % 4) js += ' ';
  Pad(bin, 0);

  uint32_t total = 12 + 8 + (uint32_t)js.size() + 8 + (uint32_t)bin.size();
  std::ofstream out(path, std::ios::binary);
  if (!out) return false;
  auto u32 = [&](uint32_t v) { out.write(reinterpret_cast<const char*>(&v), 4); };
  u32(0x46546C67); u32(2); u32(total);
  u32((uint32_t)js.size()); u32(0x4E4F534A);
  out.write(js.data(), js.size());
  u32((uint32_t)bin.size()); u32(0x004E4942);
  out.write(reinterpret_cast<const char*>(bin.data()), bin.size());
  return out.good();
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::cerr << "usage: skp2glb <in.skp> <out.glb>\n";
    return 2;
  }
  SUInitialize();
  SUModelRef model = SU_INVALID;
  SUModelLoadStatus status;
  if (SUModelCreateFromFileWithStatus(&model, argv[1], &status) != SU_ERROR_NONE) {
    std::cerr << "failed to open " << argv[1] << "\n";
    SUTerminate();
    return 1;
  }
  SUEntitiesRef root = SU_INVALID;
  SUModelGetEntities(model, &root);

  Exporter ex;
  ex.Walk(root, Identity(), SU_INVALID, "Untagged");

  size_t verts = 0, tris = 0;
  for (auto& [k, b] : ex.buckets) verts += b.positions.size() / 3, tris += b.indices.size() / 3;
  bool ok = WriteGlb(argv[2], ex.buckets);
  std::cout << "material/tag groups: " << ex.buckets.size() << ", vertices: " << verts
            << ", triangles: " << tris << ", hidden skipped: " << ex.skippedHidden << "\n"
            << (ok ? "wrote " : "FAILED writing ") << argv[2] << "\n";

  SUModelRelease(&model);
  SUTerminate();
  return ok ? 0 : 1;
}
