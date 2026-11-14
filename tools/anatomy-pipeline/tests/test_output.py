"""Contract tests for the committed anatomy assets (no raw BodyParts3D data needed)."""
import importlib.util
import json
import pathlib
import struct

import pytest
import yaml

HERE = pathlib.Path(__file__).resolve().parent.parent
OUT = HERE.parent.parent / "app" / "public" / "anatomy"


def read_glb_json(path):
    data = path.read_bytes()
    magic, version, _length = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF" and version == 2
    chunk_len, chunk_type = struct.unpack_from("<I4s", data, 12)
    assert chunk_type == b"JSON"
    return json.loads(data[20 : 20 + chunk_len])


@pytest.fixture(scope="module")
def registry():
    return json.loads((OUT / "structures.json").read_text())


@pytest.fixture(scope="module")
def glb():
    return read_glb_json(OUT / "anatomy-core.glb")


def structures(registry):
    return [s for s in registry["structures"] if s["kind"] == "structure"]


def test_glb_nodes_are_exactly_the_registry_nodes(registry, glb):
    glb_nodes = {n["name"] for n in glb["nodes"] if "mesh" in n}
    assert glb_nodes == {s["node"] for s in structures(registry)}


def test_node_names_are_dot_free_and_not_file_derived(registry):
    for s in structures(registry):
        assert not any(c in s["node"] for c in ".[]:/")
        assert "FJ" not in s["node"] and "FJ" not in s["id"]


def test_ids_unique_and_parents_exist(registry):
    ids = [s["id"] for s in registry["structures"]]
    assert len(ids) == len(set(ids))
    for s in registry["structures"]:
        assert s["parent"] is None or s["parent"] in ids


def test_triangle_budget_and_file_size(registry):
    assert registry["totalTriangles"] == sum(s["tris"] for s in structures(registry))
    assert registry["totalTriangles"] <= 150_000
    assert (OUT / "anatomy-core.glb").stat().st_size < 6_000_000


def test_attribution_is_carried_with_the_data(registry):
    src = registry["source"]
    assert src["name"] == "BodyParts3D"
    assert "Database Center for Life Science" in src["attribution"]
    assert "CC Attribution 4.0" in src["attribution"]


def test_generated_surfaces_are_flagged_approximate(registry):
    approx = {s["id"] for s in structures(registry) if s.get("approximate")}
    assert approx == {s["id"] for s in structures(registry) if "-lobe" in s["id"] and s["id"].startswith("respiratory.lung.")}


def test_spec_expansion_produces_24_ribs_and_24_vertebrae():
    spec_module = importlib.util.spec_from_file_location("build_anatomy", HERE / "build_anatomy.py")
    mod = importlib.util.module_from_spec(spec_module)
    spec_module.loader.exec_module(mod)
    nodes = mod.expand(yaml.safe_load((HERE / "structures.yaml").read_text())["nodes"])
    ids = [n["id"] for n in nodes]
    assert len(ids) == len(set(ids))
    assert sum(".rib." in i for i in ids) == 24
    assert sum(".cervical.c" in i or ".thoracic.t" in i or ".lumbar.l" in i for i in ids) == 7 + 12 + 5
