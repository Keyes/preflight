// Read-only probe: opens a .skp and prints what is inside.
#include <SketchUpAPI/common.h>
#include <SketchUpAPI/initialize.h>
#include <SketchUpAPI/model/component_definition.h>
#include <SketchUpAPI/model/component_instance.h>
#include <SketchUpAPI/model/edge.h>
#include <SketchUpAPI/model/face.h>
#include <cmath>
#include <array>
#include <SketchUpAPI/model/entities.h>
#include <SketchUpAPI/model/group.h>
#include <SketchUpAPI/model/material.h>
#include <SketchUpAPI/model/model.h>
#include <SketchUpAPI/model/texture.h>
#include <SketchUpAPI/unicodestring.h>

#include <iostream>
#include <string>
#include <vector>

struct Counts {
  size_t faces = 0, groups = 0, instances = 0, maxDepth = 0;
  // Edge flags: SketchUp smooths shading across a pair of faces whose shared edge is "smooth" or "soft".
  size_t edges = 0, softEdges = 0, smoothEdges = 0, sharedEdges = 0, sharedSmoothOrSoft = 0;
  // Angle between the two faces at an edge, in buckets: <1, 1-5, 5-15, 15-45, 45+ degrees; [flagged][unflagged]
  std::array<std::array<size_t, 5>, 2> angles{};
};

static void Walk(SUEntitiesRef entities, size_t depth, Counts& c) {
  if (depth > c.maxDepth) c.maxDepth = depth;

  size_t n = 0;
  SUEntitiesGetNumFaces(entities, &n);
  c.faces += n;

  size_t edgeCount = 0;
  SUEntitiesGetNumEdges(entities, false, &edgeCount);
  if (edgeCount > 0) {
    std::vector<SUEdgeRef> edges(edgeCount);
    SUEntitiesGetEdges(entities, false, edgeCount, edges.data(), &edgeCount);
    for (size_t i = 0; i < edgeCount; i++) {
      bool soft = false, smooth = false;
      size_t faceCount = 0;
      SUEdgeGetSoft(edges[i], &soft);
      SUEdgeGetSmooth(edges[i], &smooth);
      SUEdgeGetNumFaces(edges[i], &faceCount);
      c.edges++;
      if (soft) c.softEdges++;
      if (smooth) c.smoothEdges++;
      if (faceCount == 2) {
        c.sharedEdges++;
        if (soft || smooth) c.sharedSmoothOrSoft++;
        SUFaceRef pair[2];
        size_t got = 0;
        SUVector3D n0, n1;
        if (SUEdgeGetFaces(edges[i], 2, pair, &got) == SU_ERROR_NONE && got == 2 &&
            SUFaceGetNormal(pair[0], &n0) == SU_ERROR_NONE && SUFaceGetNormal(pair[1], &n1) == SU_ERROR_NONE) {
          double dot = std::max(-1.0, std::min(1.0, n0.x * n1.x + n0.y * n1.y + n0.z * n1.z));
          double deg = std::acos(dot) * 180.0 / M_PI;
          int bucket = deg < 1 ? 0 : deg < 5 ? 1 : deg < 15 ? 2 : deg < 45 ? 3 : 4;
          c.angles[(soft || smooth) ? 0 : 1][bucket]++;
        }
      }
    }
  }

  SUEntitiesGetNumGroups(entities, &n);
  if (n > 0) {
    std::vector<SUGroupRef> groups(n);
    SUEntitiesGetGroups(entities, n, groups.data(), &n);
    c.groups += n;
    for (size_t i = 0; i < n; i++) {
      SUEntitiesRef child = SU_INVALID;
      SUGroupGetEntities(groups[i], &child);
      Walk(child, depth + 1, c);
    }
  }

  SUEntitiesGetNumInstances(entities, &n);
  if (n > 0) {
    std::vector<SUComponentInstanceRef> instances(n);
    SUEntitiesGetInstances(entities, n, instances.data(), &n);
    c.instances += n;
    for (size_t i = 0; i < n; i++) {
      SUComponentDefinitionRef def = SU_INVALID;
      SUComponentInstanceGetDefinition(instances[i], &def);
      SUEntitiesRef child = SU_INVALID;
      SUComponentDefinitionGetEntities(def, &child);
      Walk(child, depth + 1, c);
    }
  }
}

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << "usage: probe <file.skp>\n";
    return 2;
  }
  SUInitialize();

  SUModelRef model = SU_INVALID;
  SUModelLoadStatus status;
  SUResult res = SUModelCreateFromFileWithStatus(&model, argv[1], &status);
  if (res != SU_ERROR_NONE) {
    std::cerr << "load failed, SUResult=" << res << "\n";
    SUTerminate();
    return 1;
  }
  std::cout << "load status: " << status
            << (status == SUModelLoadStatus_Success_MoreRecent ? " (file newer than SDK)" : "")
            << "\n";

  SUEntitiesRef root = SU_INVALID;
  SUModelGetEntities(model, &root);
  Counts c;
  Walk(root, 0, c);
  std::cout << "faces (instanced geometry counted once per use): " << c.faces
            << "\ngroups: " << c.groups << "\ninstances: " << c.instances
            << "\nmax nesting depth: " << c.maxDepth << "\n"
            << "edges: " << c.edges << " (soft " << c.softEdges << ", smooth " << c.smoothEdges
            << "), shared by two faces: " << c.sharedEdges << ", of which soft or smooth: "
            << c.sharedSmoothOrSoft << "\n"
            << "angle between faces (<1, 1-5, 5-15, 15-45, 45+ degrees):\n";
  for (int flagged = 0; flagged < 2; flagged++) {
    std::cout << (flagged ? "  unflagged (hard) edges: " : "  flagged soft/smooth edges: ");
    for (size_t b : c.angles[flagged == 0 ? 0 : 1]) std::cout << b << "  ";
    std::cout << "\n";
  }

  size_t nm = 0;
  SUModelGetNumMaterials(model, &nm);
  std::vector<SUMaterialRef> mats(nm);
  SUModelGetMaterials(model, nm, mats.data(), &nm);
  std::cout << "\nmaterials in model: " << nm << "\n";
  for (size_t i = 0; i < nm; i++) {
    SUStringRef name = SU_INVALID;
    SUStringCreate(&name);
    SUMaterialGetNameLegacyBehavior(mats[i], &name);
    size_t len = 0;
    SUStringGetUTF8Length(name, &len);
    std::string n(len, '\0');
    SUStringGetUTF8(name, len + 1, n.data(), &len);
    SUStringRelease(&name);
    SUMaterialType type;
    SUMaterialGetType(mats[i], &type);
    SUTextureRef tex = SU_INVALID;
    bool hasTex = SUMaterialGetTexture(mats[i], &tex) == SU_ERROR_NONE;
    std::cout << "  " << n << "  type=" << type << (hasTex ? "  has-texture" : "") << "\n";
  }

  SUModelRelease(&model);
  SUTerminate();
  return 0;
}
