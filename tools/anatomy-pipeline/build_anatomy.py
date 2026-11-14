#!/usr/bin/env python3
"""Build MEDSCOPE's anatomy GLB + structure registry from raw BodyParts3D OBJ data.

Usage (run with isolated mode, raw data in its own directory):
    .venv/bin/python -I build_anatomy.py --raw /path/to/bp3d --out ../../app/public/anatomy

--raw must contain: obj/partof_BP3D_4.0_obj_99/*.obj,
                    partof_element_parts.txt (concept -> element files).
Structure ids come from structures.yaml only; BodyParts3D file names never leave this script.
"""
import argparse
import collections
import itertools
import json
import pathlib
import re
import sys

import fast_simplification
import numpy as np
from scipy import ndimage
from skimage import measure
import trimesh
import yaml

HERE = pathlib.Path(__file__).resolve().parent
TRIS_BUDGET = 150_000  # whole-scene target for standalone Quest


def expand(nodes):
    """Expand `foreach` templates into concrete node dicts."""
    out = []
    for node in nodes:
        if "foreach" not in node:
            out.append(node)
            continue
        spec = node["foreach"]
        names = list(spec)
        for combo in itertools.product(*(spec[n] for n in names)):
            fields = {}
            for name, value in zip(names, combo):
                if isinstance(value, list):
                    for i, v in enumerate(value):
                        fields[f"{name}{i}"] = v
                else:
                    fields[name] = value
            concrete = {}
            for k, v in node.items():
                if k == "foreach":
                    continue
                concrete[k] = v.format(**fields) if isinstance(v, str) else v
            out.append(concrete)
    return out


def load_concepts(raw: pathlib.Path):
    elements = collections.defaultdict(set)
    names = {}
    for line in list(open(raw / "partof_element_parts.txt", encoding="utf-8"))[1:]:
        concept, name, element = line.rstrip("\n").split("\t")
        elements[concept].add(element)
        names[concept] = name
    return elements, names


def load_isa_elements(raw: pathlib.Path):
    """is-a archive element sets, used to split e.g. pulmonary arteries from veins."""
    elements = collections.defaultdict(set)
    for line in list(open(raw / "isa_element_parts.txt", encoding="utf-8"))[1:]:
        concept, _name, element = line.rstrip("\n").split("\t")
        elements[concept].add(element)
    return elements


def load_elements(objdir: pathlib.Path, element_ids):
    meshes = []
    for eid in sorted(element_ids):
        path = objdir / f"{eid}.obj"
        if path.exists():
            meshes.append(trimesh.load(path, force="mesh", process=False))
    return trimesh.util.concatenate(meshes) if meshes else None


def to_model_space(mesh, origin_mm):
    """BodyParts3D (mm; X patient-left, Y posterior, Z up) -> metres, Y-up, facing +Z.

    (X, Y, Z) -> (X, Z, -Y) is a proper rotation, so triangle winding is preserved.
    The patient's right (-X) therefore appears on the viewer's left, as in a clinical view.
    """
    v = np.asarray(mesh.vertices, dtype=np.float64)
    origin = np.asarray(origin_mm, dtype=np.float64)
    v = v - origin
    out = np.column_stack([v[:, 0], v[:, 2], -v[:, 1]]) * 0.001
    return trimesh.Trimesh(out, mesh.faces, process=False)


def clean(mesh):
    mesh.merge_vertices()
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    return mesh


def clip_faces(mesh, axis, lo=None, hi=None):
    """Keep only faces whose three vertices all lie within [lo, hi] on `axis` (hard cut)."""
    coords = np.asarray(mesh.vertices)[:, axis][np.asarray(mesh.faces)]
    keep = np.ones(len(mesh.faces), dtype=bool)
    if lo is not None:
        keep &= (coords >= lo).all(axis=1)
    if hi is not None:
        keep &= (coords <= hi).all(axis=1)
    mesh.update_faces(keep)
    mesh.remove_unreferenced_vertices()
    return mesh


def decimate(mesh, target_tris):
    n = len(mesh.faces)
    if target_tris is None or n <= target_tris:
        return mesh
    reduction = float(np.clip(1.0 - target_tris / n, 0.0, 0.98))
    pts, faces = fast_simplification.simplify(
        np.asarray(mesh.vertices, dtype=np.float32),
        np.asarray(mesh.faces, dtype=np.int32),
        target_reduction=reduction,
    )
    return clean(trimesh.Trimesh(pts, faces, process=False))


def build_envelopes(items, pitch=0.0025, grow=0.014, sigma=1.5):
    """Approximate lobe surfaces for one lung from each lobe's own airway/vessel geometry.

    BodyParts3D 4.0 has no continuous lung parenchyma. For lobes of one lung this:
      1. voxelises each lobe's geometry,
      2. grows the union outward by `grow` metres (peripheral branches end short of the pleura),
      3. fills/closes it, then partitions it between lobes by nearest lobe geometry
         (so lobes meet along fissure-like boundaries),
      4. smooths each lobe mask and extracts a surface with marching cubes.
    The result is a plausible lobe *envelope*, not a segmentation of real parenchyma, and is
    flagged `approximate` in the registry.
    """
    all_v = np.vstack([m.vertices for _, m in items])
    lo = all_v.min(axis=0) - (grow + 0.02)
    hi = all_v.max(axis=0) + (grow + 0.02)
    shape = tuple(int(x) for x in np.ceil((hi - lo) / pitch) + 1)
    occupied = []
    for _, mesh in items:
        pts = np.vstack([mesh.vertices, mesh.sample(max(30000, len(mesh.faces) * 6))])
        idx = np.clip(np.floor((pts - lo) / pitch).astype(int), 0, np.array(shape) - 1)
        grid = np.zeros(shape, dtype=bool)
        grid[idx[:, 0], idx[:, 1], idx[:, 2]] = True
        occupied.append(grid)
    union = np.any(occupied, axis=0)
    region = ndimage.distance_transform_edt(~union, sampling=pitch) <= grow
    region = ndimage.binary_closing(region, iterations=int(round(0.008 / pitch)))
    region = ndimage.binary_fill_holes(region)
    owner = np.stack([ndimage.distance_transform_edt(~g, sampling=pitch) for g in occupied]).argmin(axis=0)
    out = []
    for i, (node, _) in enumerate(items):
        field = ndimage.gaussian_filter((region & (owner == i)).astype(np.float32), sigma)
        verts, faces, _n, _v = measure.marching_cubes(field, level=0.5, spacing=(pitch, pitch, pitch))
        mesh = clean(trimesh.Trimesh(verts + lo, faces, process=False))
        # A long vessel can leave a detached blob far from the lobe; keep the main body only.
        parts = mesh.split(only_watertight=False)
        if len(parts) > 1:
            mesh = max(parts, key=lambda part: len(part.faces))
        out.append((node, mesh))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, type=pathlib.Path)
    ap.add_argument("--out", required=True, type=pathlib.Path)
    ap.add_argument("--spec", default=HERE / "structures.yaml", type=pathlib.Path)
    args = ap.parse_args()

    spec = yaml.safe_load(open(args.spec, encoding="utf-8"))
    nodes = expand(spec["nodes"])
    elements, names = load_concepts(args.raw)
    isa_elements = load_isa_elements(args.raw)
    by_name = collections.defaultdict(list)
    for concept, name in names.items():
        by_name[name].append(concept)
    objdir = args.raw / "obj" / spec["source"]["archive"]

    ids = [n["id"] for n in nodes]
    dupes = [i for i, c in collections.Counter(ids).items() if c > 1]
    if dupes:
        sys.exit(f"duplicate ids in spec: {dupes}")

    scene = trimesh.Scene()
    registry = {}
    problems = []
    used_elements = collections.defaultdict(list)  # element id -> structure ids

    envelope_jobs = collections.defaultdict(list)

    def finish(node, entry, mesh):
        before = len(mesh.faces)
        mesh = decimate(mesh, node.get("target_tris"))
        mesh.vertex_normals  # smooth normals, cached for export
        scene.add_geometry(mesh, node_name=entry["node"], geom_name=entry["node"])
        entry["tris"] = int(len(mesh.faces))
        entry["trisSource"] = int(before)
        entry["bounds"] = [np.round(mesh.bounds[0], 4).tolist(), np.round(mesh.bounds[1], 4).tolist()]

    for node in nodes:
        entry = {
            "id": node["id"],
            "name": node["name"],
            "kind": node["kind"],
            "system": node["system"],
            "parent": node.get("parent"),
            "fma": node.get("fma"),
            "aliases": node.get("aliases", []),
            "children": [],
        }
        if node["kind"] == "structure":
            # three.js GLTFLoader strips "." from node names, so the GLB node name is an
            # explicit dot-free encoding recorded here; the runtime never guesses.
            entry["node"] = node["id"].replace(".", "__")
        registry[node["id"]] = entry
        if node["kind"] == "group":
            continue

        if "match_name" in node:
            hits = by_name.get(node["match_name"], [])
            if len(hits) != 1:
                problems.append(f"{node['id']}: name '{node['match_name']}' matched {hits}")
                continue
            concepts = hits
            entry["fma"] = hits[0]
        elif "match_regex" in node:
            pat = re.compile(node["match_regex"])
            concepts = [c for c, n in names.items() if pat.search(n)]
        else:
            concepts = node.get("concepts") or [node.get("concept") or node["envelope"]["concept"]]

        files = set()
        for c in concepts:
            files |= elements.get(c, set())
        for c in node.get("subtract", []):
            files -= elements.get(c, set())
        if "intersect_isa" in node:
            files &= isa_elements.get(node["intersect_isa"], set())
        if not files:
            problems.append(f"{node['id']}: no element meshes for {concepts}")
            continue
        if "envelope" not in node:  # envelopes are derived surfaces, they do not draw source elements
            for f in files:
                used_elements[f].append(node["id"])

        raw_mesh = load_elements(objdir, files)
        if raw_mesh is None:
            problems.append(f"{node['id']}: element files missing on disk")
            continue
        mesh = clean(to_model_space(raw_mesh, spec["origin_mm"]))
        if "clip_below_y" in node:
            mesh = clip_faces(mesh, 1, lo=node["clip_below_y"])
        if "clip_abs_x" in node:
            mesh = clip_faces(mesh, 0, lo=-node["clip_abs_x"], hi=node["clip_abs_x"])
        if "envelope" in node:
            envelope_jobs[node["envelope"]["lung"]].append((node, entry, mesh))
            continue
        finish(node, entry, mesh)

    for lung, jobs in envelope_jobs.items():
        built = build_envelopes([(job[0], job[2]) for job in jobs])
        for (node, entry, _src), (_n, mesh) in zip(jobs, built):
            entry["approximate"] = True
            finish(node, entry, mesh)

    # element sharing between structures would draw the same triangles twice
    shared = {e: s for e, s in used_elements.items() if len(s) > 1}
    for e, s in shared.items():
        problems.append(f"element shared by {s}")

    # hierarchy + group bounds
    for e in registry.values():
        p = e["parent"]
        if p:
            if p not in registry:
                problems.append(f"{e['id']}: unknown parent {p}")
            else:
                registry[p]["children"].append(e["id"])

    def descendants(i):
        for c in registry[i]["children"]:
            yield c
            yield from descendants(c)

    for e in registry.values():
        if e["kind"] == "group":
            boxes = [registry[d]["bounds"] for d in descendants(e["id"]) if "bounds" in registry[d]]
            if boxes:
                lo = np.min([b[0] for b in boxes], axis=0)
                hi = np.max([b[1] for b in boxes], axis=0)
                e["bounds"] = [np.round(lo, 4).tolist(), np.round(hi, 4).tolist()]
            e["tris"] = int(sum(registry[d].get("tris", 0) for d in descendants(e["id"])))
        if "bounds" in e:
            lo, hi = np.array(e["bounds"][0]), np.array(e["bounds"][1])
            e["center"] = np.round((lo + hi) / 2, 4).tolist()
            e["size"] = np.round(hi - lo, 4).tolist()

    if problems:
        print("PROBLEMS:")
        for p in problems:
            print("  -", p)
        sys.exit(1)

    args.out.mkdir(parents=True, exist_ok=True)
    glb = scene.export(file_type="glb", include_normals=True)
    (args.out / "anatomy-core.glb").write_bytes(glb)

    total = sum(e.get("tris", 0) for e in registry.values() if e["kind"] == "structure")
    doc = {
        "schema": 1,
        "model": {
            "glb": "anatomy-core.glb",
            "units": "m",
            "up": "Y",
            "facing": "+Z",
            "origin": "mid-thorax, on the body midline",
            "nodeNameField": "node",
        },
        "source": spec["source"],
        "systems": spec["systems"],
        "totalTriangles": total,
        "structures": list(registry.values()),
    }
    (args.out / "structures.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")

    structures = [e for e in registry.values() if e["kind"] == "structure"]
    per_system = collections.Counter()
    for e in structures:
        per_system[e["system"]] += e["tris"]
    print(f"structures: {len(structures)}  groups: {len(registry) - len(structures)}")
    print(f"triangles : {total:,}  (budget {TRIS_BUDGET:,})  {dict(per_system)}")
    print(f"glb       : {len(glb) / 1e6:.2f} MB -> {args.out / 'anatomy-core.glb'}")
    if total > TRIS_BUDGET:
        sys.exit(f"over triangle budget by {total - TRIS_BUDGET:,}")


if __name__ == "__main__":
    main()
