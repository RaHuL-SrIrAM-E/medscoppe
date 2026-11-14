# Anatomy pipeline

Builds MEDSCOPE's anatomy runtime assets from raw BodyParts3D data.

```
structures.yaml ──┐
raw BodyParts3D ──┴─> build_anatomy.py ──> app/public/anatomy/anatomy-core.glb
(not committed)                          └> app/public/anatomy/structures.json
```

`structures.yaml` is the **single source of truth for stable structure ids**
(`respiratory.lung.right.upper-lobe`, `skeletal.thoracic-cage.rib.left.4`, ...). Ids are
MEDSCOPE-owned and anchored to an ontology concept through `fma`; they are never derived
from BodyParts3D file names (`FJ####`), which only appear inside this tool. Renaming an id is
a breaking change for scenarios, voice aliases and evidence references.

## Run

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt

# 1. Download release 4.0 into a NEW, EMPTY directory (do not run tools from inside it):
B=https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST
mkdir /path/to/bp3d && cd /path/to/bp3d
curl -O $B/partof_BP3D_4.0_obj_99.zip -O $B/partof_element_parts.txt -O $B/isa_element_parts.txt
mkdir obj && unzip -q partof_BP3D_4.0_obj_99.zip -d obj

# 2. Build (isolated mode, raw data passed as an argument)
cd tools/anatomy-pipeline
.venv/bin/python -I build_anatomy.py --raw /path/to/bp3d --out ../../app/public/anatomy

# 3. Contract tests (run against the committed output, no raw data needed)
.venv/bin/python -m pytest -q
```

The build fails if a spec entry matches no geometry, if two structures would draw the same
source element, or if the scene exceeds the 150,000-triangle standalone-Quest budget.

## What it does

1. Merges each concept's element OBJ files, optionally subtracting sub-concepts
   (`subtract`) or intersecting with an is-a class (`intersect_isa`, used to split
   pulmonary arteries from veins).
2. Converts BodyParts3D coordinates (mm, Z-up, anterior = -Y, patient right = -X) to metres,
   Y-up, facing +Z, origin at mid-thorax. The patient's right appears on the viewer's left.
3. Welds, decimates (`target_tris`), smooths normals.
4. **Generates lung lobe envelopes** (`envelope`). BodyParts3D 4.0 has no continuous lung
   parenchyma; each lobe's own airway and vessel geometry is voxelised, grown, partitioned
   between lobes and surfaced. These are flagged `approximate: true`. See
   `docs/asset-licenses.md`.
5. Writes the GLB (node name = the registry's dot-free `node` field; three.js strips dots) and
   the registry JSON (hierarchy, FMA ids, aliases, bounds, triangle counts, attribution).

Licensing and attribution: `docs/asset-licenses.md`.
