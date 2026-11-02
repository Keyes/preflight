# skp2glb converter

Small native program that reads a `.skp` with the SketchUp C SDK and writes a GLB. The Node server spawns it:

```
skp2glb <in.skp> <out.glb>
```

`probe` is a read-only helper that opens a `.skp` and prints face, group, instance and edge counts (including how many edges are soft or smooth, and how sharp the angle between neighbouring faces is for flagged and unflagged edges), plus every material's type and whether it has a texture:

```
probe <file.skp>
```

## Setup

Where to get the SketchUp C SDK and how to build the converter on macOS, Windows (untested) and Linux (no SDK) is in the main [README](../README.md#the-sketchup-sdk). In short, on macOS, with the SDK unpacked as `SketchUp_SDK/` in the repository root:

```
cmake -S converter -B converter/build -DCMAKE_BUILD_TYPE=Release
cmake --build converter/build
```

The programs land in `converter/build/` on every platform (`skp2glb.exe` on Windows, with the SDK's DLLs copied next to it), which is where the server looks for them.

## What it does

- Opens the model and walks groups and component instances recursively, applying their transforms.
- Tessellates faces with the SDK's mesh helper and merges them per tag and material. Each tag becomes its own glTF node named `tag:<name>`, so the viewer can hide it; a part takes the tag of its group or component when it has none of its own ("Untagged" is the default).
- Converts inches to meters, and SketchUp's Z-up axes to glTF's Y-up.
- Faces without a material of their own take the nearest parent group's or component's material, as SketchUp does.
- Exports material colors, opacity and textures (embedded as PNG, with UV coordinates).
- Skips hidden entities and entities on hidden tags (layers).

## Known gaps

- Colorized textures lose their tint.
- A texture inherited from a parent uses a simple planar mapping, which only approximates SketchUp's.
- Repeated components are written out once per use instead of being instanced, so output files can be larger than necessary.
- Shading follows SketchUp: faces joined by soft/smooth edges are shaded smoothly (the SDK's mesh helper already provides those normals), and hard edges stay hard. The curved vault in the venue it was tested with looks faceted because its edges are hard in the model itself, not because information is lost. An optional "auto smooth" by angle would round it but differ from SketchUp; it is not built.

The server caches the result by the SHA-256 of the uploaded file and the identity of the converter build (size and modification time of the binary), so uploading the same file again does not run the converter, but rebuilding the converter makes the next upload convert again. The model URL carries the same identity, so browsers do not keep an old copy.

Venues uploaded as glTF (`.glb`, or a self-contained `.gltf`) don't go through the converter at all: the server checks them and stores them as they are, and the Re-convert button doesn't apply to them. Without `tag:` nodes, the viewer offers the model's top-level nodes as its hideable parts instead.
