# Asset licences and attribution

> **Licence status: UNCONFIRMED.** The licensor's current README says CC BY 4.0, but older
> statements for the same dataset say CC BY-SA 2.1 Japan and the data files predate the change.
> We have **not** received confirmation from DBCLS. Until we do, treat the BodyParts3D-derived
> assets as **not cleared for publication**: do not push them to a public remote, do not publish
> a build, and do not submit them. A draft confirmation request is in
> `docs/dbcls-licence-inquiry-draft.md` (not sent).

Every third-party asset used by MEDSCOPE is recorded here. Add a row before adding an asset.

## Required attribution text

Wherever BodyParts3D-derived anatomy is shown or distributed, include this exact credit
(the wording the licensor prescribes in the current README):

> BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International

**Status: shown in the application** (credit line under the layer dock, `app/public/ui/layer-dock.uikitml`).
Two deliberate deviations: the copyright sign is written `(c)` because the UI font renders `©` as a
missing-glyph box, and the line adds "Adapted: merged, decimated, lung lobe volumes are illustrative
approximations" (CC BY requires indicating changes). The competition submission text still needs the credit.
Showing this credit does not make the licence confirmed.

## BodyParts3D (anatomical geometry)

| | |
|---|---|
| Source | BodyParts3D, Database Center for Life Science (DBCLS), Research Organization of Information and Systems |
| Release used | 4.0 (data dated 2013-05/06) |
| Download | https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/ |
| Files used | `partof_BP3D_4.0_obj_99.zip` (OBJ meshes, 99 % polygon reduction), `partof_element_parts.txt`, `isa_element_parts.txt` |
| Licence | **CC BY 4.0** (Creative Commons Attribution 4.0 International), https://creativecommons.org/licenses/by/4.0/ |
| Licence source | The README in the `LATEST` archive (`README_e.html`), whose update history records `2025/02/27 "License" is updated`. Read directly from the archive on 2026-11-14. |
| Conditions | Attribution as above. You must indicate that changes were made (see "Changes made"). No share-alike clause in the current text. |
| Raw data in this repo | **No.** The 217 MB OBJ archive is not committed; `tools/anatomy-pipeline` rebuilds from it. |

### Licence history (read before relying on this)

DBCLS's older READMEs say something different. The 2011 README (release 3.0 directory) states
**CC Attribution-Share Alike 2.1 Japan** with a different attribution string and a share-alike
condition. The release 4.0 data files are dated 2013, but the README published alongside them
in `LATEST` was updated on 2025-02-27 to **CC BY 4.0**. We rely on the licensor's current
statement for the files we downloaded from `LATEST`.

Because the files predate the 2025 relicensing, the cautious reading is worth a short email to
the licensor before the competition submission: *"Please confirm that BodyParts3D release 4.0
mesh data downloaded from /data/bodyparts3d/LATEST/ may be redistributed in adapted form under
CC BY 4.0."* DBCLS contact address is given in the README. If the answer is anything other than
yes, the derived GLB in this repo must be removed or relicensed (the share-alike variant would
require the adapted data to be released under the same terms).

We deliberately used **only release 4.0**. Release 3.0 contains continuous lung organ meshes but
carries the older licence text and a different skeleton alignment (release notes: the 4.0
skeleton was shifted to make room for large internal organs), so mixing releases would add
legal and geometric uncertainty.

### Changes made (CC BY 4.0 requires this to be stated)

The files in `app/public/anatomy/` are **adapted material**, not the original data:

- Element meshes were merged into one mesh per anatomical concept, and concepts were re-split
  using the dataset's own part-of and is-a element lists (e.g. lung-lobe concepts include their
  bronchial trees and pulmonary vessels; these were separated into airways, arteries and veins).
- Coordinates were converted (mm, Z-up -> metres, Y-up, facing +Z) and re-centred on the mid-thorax.
- Meshes were welded, decimated (about 1.1 M input triangles, counted per structure, to about 132 k) and given smooth normals.
- The skin surface was cropped to the torso.
- **Lung lobe surfaces are generated, not source data.** BodyParts3D 4.0 has no continuous lung
  parenchyma meshes. Each lobe "envelope" is a smoothed volume grown from that lobe's own airway and
  vessel geometry and partitioned between neighbouring lobes. It is marked `approximate: true` in
  `structures.json`. It must not be presented as a segmented lung surface.
  - **Presentation:** each lobe is named "... (illustrative volume)", its info card always shows
    "Illustrative volume generated from airway and vessel geometry. Not an actual lung surface. Not for
    clinical reasoning.", and the dock credit says the volumes are approximations.
  - **Never evidence:** `AnatomyRegistry.isEvidenceEligible(id)` returns `false` for these structures and
    for any group that contains them. Clinical-reasoning code must use it. The real BodyParts3D
    airways and pulmonary arteries and veins remain eligible. Covered by `anatomy.test.ts`.

### Files derived from BodyParts3D

| File | Content |
|---|---|
| `app/public/anatomy/anatomy-core.glb` | 78 meshes, about 132,000 triangles, 3.3 MB (rebuilds can differ by a few triangles: the pipeline is not bit-for-bit deterministic) |
| `app/public/anatomy/structures.json` | Registry: stable ids, hierarchy, FMA ids, aliases, bounds |

Both are distributed under CC BY 4.0 with the attribution above. Built by
`tools/anatomy-pipeline/build_anatomy.py` from `structures.yaml`.

### Ontology identifiers

Structures carry Foundational Model of Anatomy (FMA) concept ids as supplied by BodyParts3D
(for example `FMA7309` right lung). FMA is referenced only as an identifier. No FMA text or
hierarchy beyond what BodyParts3D itself distributes is included.

## Candidates considered and not used

| Source | Licence | Why not (yet) |
|---|---|---|
| Z-Anatomy | CC BY-SA 4.0 (repository `License.txt`) | **Possible replacement for a later iteration** (real lung surfaces, muscular and nervous systems). Not introduced now by decision. It ships as an 87 MB Blender file derived from BodyParts3D, share-alike would apply to adapted geometry, and it needs a Blender export step and its own licence review. |
| BodyParts3D release 3.0 | CC BY-SA 2.1 Japan (2011 README) | Older licence text, different alignment (see above). |

## Other content

| Item | Licence | Notes |
|---|---|---|
| Structure descriptions (`app/public/anatomy/structure-info.json`) | Authored for MEDSCOPE | Standard anatomical reference statements. **Unreviewed by a clinician**; marked `reviewStatus: unreviewed` and labelled as such in the UI. Educational only. |
| Software dependencies (IWSDK, Three.js, UIKit, etc.) | Per package | Not assets. Run `npm ls` and each package's licence for a software bill of materials. UI fonts shipped by `@pmndrs/uikit` have **not** been audited. |

## Open items

1. **Send the DBCLS confirmation request** (`docs/dbcls-licence-inquiry-draft.md`) and record the reply here. Until then the licence is unconfirmed and the assets must not be published or pushed.
2. Add the required credit to the competition submission text.
3. Audit fonts used by the UIKit panels. The production bundle includes a font chunk named `inter` (the Inter typeface, normally SIL OFL 1.1), shipped by `@pmndrs/uikit`; the licence has not been verified.
4. Later iteration: evaluate Z-Anatomy (or another source) for real lung surfaces and for muscular and nervous systems; record its licence here first.
