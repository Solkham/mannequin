"""Выгрузка модели Anny (NAVER, Apache 2.0) в glTF для браузера.

Для каждого пола пишет public/models/anny-<пол>.glb: базовая сетка взрослого
человека в A-позе плюс морф-таргеты (положения и нормали):

    height_up / height_down   рост (фенотип Anny height)
    weight_up / weight_down   вес (фенотип Anny weight)
    chest_up  / chest_down    обхват груди (локальная правка measure-bust-circ)
    waist_up  / waist_down    обхват талии (measure-waist-circ)
    hips_up   / hips_down     обхват бёдер (measure-hips-circ)

Морфы на одну величину разбиты на «вверх» и «вниз», потому что Anny
интерполирует фенотип кусочно-линейно: влияние 1.0 у *_up равно параметру
в максимуме, у *_down в минимуме.

Рядом пишет public/models/anny-meta.json: какие вершины мерить для груди,
талии и бёдер, плотность тела для веса и как рост Anny зависит от морфа роста.
Браузер по этим данным сам подбирает влияния морфов под введённые сантиметры.

Запуск (нужен Python 3.10+, CPU хватает, около 2 минут):
    python -m venv .venv && . .venv/bin/activate
    pip install -r scripts/requirements.txt
    python scripts/export_anny.py
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np
import torch

import anny
from anny.anthropometry import BASE_MESH_WAIST_VERTICES

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "models"

# В Anny gender=0 мужчина, gender=1 женщина. age=2/3 это якорь "young"
# (взрослый без примеси детских пропорций).
GENDERS = {"male": 0.0, "female": 1.0}
AGE_ADULT = 2.0 / 3.0

LOCAL = {
    "chest": "measure-bust-circ-incr",
    "waist": "measure-waist-circ-incr",
    "hips": "measure-hips-circ-incr",
}

# Вес манекена = объём сетки * плотность. В Anny (anthropometry.py) стоит 980 кг/м³,
# но с ней средние фигуры (168 см, 92-74-100) выходят на 4-5 кг легче живых людей
# с теми же обхватами. 1040 подобрано так, чтобы средним фигурам не нужно было
# раздувать морф веса. Это калибровка, а не физика.
DENSITY = 1040.0

ARM_BONE_KEYS = ("arm", "shoulder", "wrist", "finger", "metacarpal", "hand")

# Части тела для одежды (src/garment.ts): номер части = индекс в этом списке.
# Вершина относится к части, чьи кости дают ей наибольший суммарный вес.
PARTS = [
    ("torso", ("root", "pelvis", "spine", "clavicle")),
    ("neck", ("neck",)),
    ("head", ("head", "eye", "jaw", "tongue")),
    ("upperarm1", ("shoulder", "upperarm01")),
    ("upperarm2", ("upperarm02",)),
    ("lowerarm", ("lowerarm",)),
    ("hand", ("wrist", "finger", "metacarpal")),
    ("upperleg", ("upperleg",)),
    ("lowerleg", ("lowerleg",)),
    ("foot", ("foot", "toe")),
]
LEG_BONE_KEYS = ("upperleg", "lowerleg", "foot", "toe")


# ---------------------------------------------------------------- геометрия


def vertex_normals(v: np.ndarray, f: np.ndarray) -> np.ndarray:
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    n = np.zeros_like(v)
    for k in range(3):
        np.add.at(n, f[:, k], fn)
    n /= np.linalg.norm(n, axis=1, keepdims=True).clip(1e-12)
    return n


def hull_perimeter(p: np.ndarray) -> float:
    """Периметр выпуклой оболочки точек на плоскости: так ложится сантиметр."""
    pts = sorted(map(tuple, p))
    if len(pts) < 3:
        return 0.0

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for q in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], q) <= 0:
            lower.pop()
        lower.append(q)
    for q in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], q) <= 0:
            upper.pop()
        upper.append(q)
    hull = np.array(lower[:-1] + upper[:-1])
    return float(np.linalg.norm(hull - np.roll(hull, 1, axis=0), axis=1).sum())


def mesh_volume(v: np.ndarray, f: np.ndarray) -> float:
    return float(abs(np.einsum("ij,ij->i", np.cross(v[f[:, 0]], v[f[:, 1]]), v[f[:, 2]]).sum()) / 6.0)


def measure(v: np.ndarray, f: np.ndarray, rings: dict[str, list[int]]) -> dict[str, float]:
    """Те же замеры, что делает браузер (src/body.ts). v в системе glTF: Y вверх."""
    out = {name: hull_perimeter(v[idx][:, [0, 2]]) for name, idx in rings.items()}
    out["height"] = float(v[:, 1].max() - v[:, 1].min())
    out["mass"] = mesh_volume(v, f) * DENSITY
    return out


# ---------------------------------------------------------------- Anny


def build_model() -> anny.Anny:
    return anny.Anny(
        topology="anny-notongue",
        local_changes=list(LOCAL.values()),
        phenotypes="all",
    )


def rest_shape(model, gender: float, **over) -> tuple[np.ndarray, np.ndarray]:
    """Вершины и головы костей в позе покоя (A-поза) для заданного фенотипа."""
    phen = {k: 0.5 for k in model.phenotype_labels}
    phen.update(gender=gender, age=AGE_ADULT)
    local = {LOCAL[k[len("local_"):]]: over.pop(k) for k in list(over) if k.startswith("local_")}
    phen.update(over)
    with torch.no_grad():
        out = model(phenotype_kwargs=phen, local_changes_kwargs=local or None)
    return (out["rest_vertices"][0].double().cpu().numpy(),
            out["rest_bone_heads"][0].double().cpu().numpy())


def rest_vertices(model, gender: float, **over) -> np.ndarray:
    return rest_shape(model, gender, **over)[0]


def skin_weights(model) -> tuple[np.ndarray, np.ndarray]:
    """4 самые сильные кости на вершину (столько понимает Three.js), веса нормированы."""
    w = model.vertex_bone_weights.cpu().numpy()
    idx = model.vertex_bone_indices.cpu().numpy()
    order = np.argsort(-w, axis=1)[:, :4]
    w4 = np.take_along_axis(w, order, axis=1)
    j4 = np.take_along_axis(idx, order, axis=1)
    w4 /= w4.sum(axis=1, keepdims=True).clip(1e-9)
    j4[w4 == 0] = 0
    return j4.astype(np.uint8), w4.astype(np.float32)


def to_gltf_axes(v: np.ndarray, forward_sign: float) -> np.ndarray:
    """Anny: Z вверх, лицо в сторону forward_sign по Y. glTF: Y вверх, лицо в +Z.

    Это поворот (определитель +1), а не отражение: иначе вывернутся грани.
    """
    return np.stack([-forward_sign * v[:, 0], v[:, 2], forward_sign * v[:, 1]], axis=1)


def bone_mask(model, keys: tuple[str, ...]) -> np.ndarray:
    labels = model.bone_labels
    w = model.vertex_bone_weights.cpu().numpy()
    idx = model.vertex_bone_indices.cpu().numpy()
    hit = np.array([any(k in labels[i].lower() for k in keys) for i in range(len(labels))])
    return (w * hit[idx]).sum(axis=1)


def body_parts(model) -> str:
    """Строка из цифр: часть тела каждой вершины (см. PARTS)."""
    scores = np.stack([bone_mask(model, keys) for _, keys in PARTS], axis=1)
    return "".join(str(i) for i in scores.argmax(axis=1))


def ring_at(v: np.ndarray, torso: np.ndarray, level: float, band: float = 0.008) -> list[int]:
    sel = np.where(torso & (np.abs(v[:, 1] - level) < band))[0]
    return sel.tolist()


def find_rings(model, v: np.ndarray) -> dict[str, list[int]]:
    """Где мерить грудь, талию и бёдра на базовой сетке (v уже в осях glTF, пол на 0)."""
    arm = bone_mask(model, ARM_BONE_KEYS)
    leg = bone_mask(model, LEG_BONE_KEYS)
    h = v[:, 1].max()
    torso = arm < 0.05

    base_ids = model.base_mesh_vertex_indices.cpu().numpy().tolist()
    waist = [base_ids.index(i) for i in BASE_MESH_WAIST_VERTICES]
    waist_y = float(v[waist, 1].mean())

    # Грудь: уровень, где торс сильнее всего выступает вперёд (+Z), между талией и подмышками.
    cand = torso & (v[:, 1] > waist_y + 0.06 * h) & (v[:, 1] < 0.80 * h)
    chest_y = float(v[cand][np.argmax(v[cand][:, 2]), 1])

    # Бёдра: самый большой обхват между промежностью и талией (по ягодицам).
    crotch_y = float(v[(leg > 0.5) & (np.abs(v[:, 0]) < 0.02), 1].max())
    levels = np.arange(crotch_y + 0.03 * h, waist_y - 0.04 * h, 0.005)
    perims = [hull_perimeter(v[ring_at(v, torso, y)][:, [0, 2]]) for y in levels]
    hips_y = float(levels[int(np.argmax(perims))])

    print(f"   уровни от пола: грудь {chest_y / h:.3f}H, талия {waist_y / h:.3f}H, "
          f"бёдра {hips_y / h:.3f}H, промежность {crotch_y / h:.3f}H")
    return {
        "chest": ring_at(v, torso, chest_y),
        "waist": waist,
        "hips": ring_at(v, torso, hips_y),
    }


# ---------------------------------------------------------------- GLB


def write_glb(path: Path, base: np.ndarray, normals: np.ndarray, faces: np.ndarray,
              targets: list[tuple[str, np.ndarray, np.ndarray]],
              skin: tuple[np.ndarray, np.ndarray, list[str], list[int], np.ndarray]) -> None:
    """skin: (joints Vx4, weights Vx4, имена костей, родители, головы костей Bx3)."""
    blobs: list[bytes] = []
    views, accessors = [], []

    def add(arr: np.ndarray, comp: int, typ: str, target: int | None, minmax: bool = False) -> int:
        data = arr.tobytes()
        offset = sum(len(b) for b in blobs)
        blobs.append(data + b"\0" * (-len(data) % 4))
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        views.append(view)
        acc = {"bufferView": len(views) - 1, "componentType": comp,
               "count": int(arr.shape[0]), "type": typ}
        if minmax:
            acc["min"] = arr.min(axis=0).tolist()
            acc["max"] = arr.max(axis=0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    def add_quant(arr: np.ndarray, comp: int, typ: str, minmax: bool = False) -> int:
        """Нормализованные целые (KHR_mesh_quantization): value = q / 32767 (int16) или q / 127 (int8).
        Строка вершины добита до 4 байт: glTF требует шаг атрибута кратный 4."""
        n, k = arr.shape
        if comp == 5122:  # int16
            q = np.clip(np.round(arr * 32767), -32767, 32767).astype(np.int16)
        elif comp == 5120:  # int8
            q = np.clip(np.round(arr * 127), -127, 127).astype(np.int8)
        else:  # uint8
            q = np.clip(np.round(arr * 255), 0, 255).astype(np.uint8)
        size = q.itemsize * k
        stride = size + (-size % 4)
        padded = np.zeros((n, stride // q.itemsize), dtype=q.dtype)
        padded[:, :k] = q
        data = padded.tobytes()
        offset = sum(len(b) for b in blobs)
        blobs.append(data + b"\0" * (-len(data) % 4))
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": 34962}
        if stride != size:
            view["byteStride"] = stride
        views.append(view)
        acc = {"bufferView": len(views) - 1, "componentType": comp, "normalized": True,
               "count": int(n), "type": typ}
        if minmax:
            scale = {5122: 32767, 5120: 127, 5121: 255}[comp]
            acc["min"] = (q.min(axis=0) / scale).tolist()
            acc["max"] = (q.max(axis=0) / scale).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    FLOAT, U8, U16, U32 = 5126, 5121, 5123, 5125
    I8, I16 = 5120, 5122
    pos = add(base.astype(np.float32), FLOAT, "VEC3", 34962, minmax=True)
    nor = add(normals.astype(np.float32), FLOAT, "VEC3", 34962)
    joints, weights, bone_names, parents, heads = skin
    jnt = add(joints, U8, "VEC4", 34962)
    wgt = add_quant(weights, U8, "VEC4")
    # Кости без поворота, только сдвиг от родителя: локальные оси = мировые.
    ibm = np.tile(np.eye(4, dtype=np.float32), (len(heads), 1, 1))
    ibm[:, 3, :3] = -heads  # столбцовый порядок glTF: перенос в последнем столбце
    ibm_acc = add(ibm.reshape(len(heads), 16), FLOAT, None, None)
    accessors[ibm_acc]["type"] = "MAT4"
    if faces.max() < 65535:
        idx = add(faces.astype(np.uint16).reshape(-1), U16, "SCALAR", 34963)
    else:
        idx = add(faces.astype(np.uint32).reshape(-1), U32, "SCALAR", 34963)

    morph = []
    for _, dp, dn in targets:
        morph.append({
            # Сдвиги морфов меньше метра: int16 даёт точность 0.03 мм. Нормали — int8 (1/127).
            "POSITION": add_quant(dp.astype(np.float32), I16, "VEC3", minmax=True),
            "NORMAL": add_quant(np.clip(dn, -1, 1).astype(np.float32), I8, "VEC3"),
        })

    names = [t[0] for t in targets]
    gltf = {
        "asset": {"version": "2.0", "generator": "mannequin/scripts/export_anny.py",
                  "copyright": "Anny body model (c) NAVER Corp., Apache-2.0; based on MakeHuman (CC0)"},
        "extensionsUsed": ["KHR_mesh_quantization"],
        "extensionsRequired": ["KHR_mesh_quantization"],
        "scene": 0,
        "scenes": [{"nodes": [0] + [1 + i for i, p in enumerate(parents) if p < 0]}],
        "nodes": [{"name": path.stem, "mesh": 0, "skin": 0}] + [
            {"name": n,
             "translation": (heads[i] - (heads[parents[i]] if parents[i] >= 0 else 0)).tolist(),
             **({"children": [1 + c for c, p in enumerate(parents) if p == i]}
                if any(p == i for p in parents) else {})}
            for i, n in enumerate(bone_names)
        ],
        "skins": [{"inverseBindMatrices": ibm_acc, "joints": [1 + i for i in range(len(heads))],
                   "skeleton": 1 + parents.index(-1)}],
        "meshes": [{
            "name": path.stem,
            "primitives": [{"attributes": {"POSITION": pos, "NORMAL": nor, "JOINTS_0": jnt, "WEIGHTS_0": wgt},
                            "indices": idx,
                            "mode": 4, "targets": morph}],
            "weights": [0.0] * len(targets),
            "extras": {"targetNames": names},
        }],
        "buffers": [{"byteLength": sum(len(b) for b in blobs)}],
        "bufferViews": views,
        "accessors": accessors,
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    binary = b"".join(blobs)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(binary), 0x004E4942) + binary)


# ---------------------------------------------------------------- main


def export_gender(model, name: str, g: float, faces: np.ndarray) -> dict:
    raw, raw_heads = rest_shape(model, g)

    # Куда смотрит лицо: носки стоп впереди пяток.
    toes = bone_mask(model, ("toe",)) > 0.5
    heel = (bone_mask(model, ("foot",)) > 0.5) & (raw[:, 2] < raw[:, 2].min() + 0.03)
    forward_sign = float(np.sign(raw[toes, 1].mean() - raw[heel, 1].mean()))

    def prep(v: np.ndarray) -> np.ndarray:
        return to_gltf_axes(v, forward_sign)

    base = prep(raw)
    # Пол на y=0, ось тела по центру. Тот же сдвиг для всех морфов,
    # браузер после смешивания ещё раз ставит модель на пол.
    shift = np.array([base[:, 0].mean(), base[:, 1].min(), base[:, 2].mean()])
    base -= shift
    heads = prep(raw_heads) - shift
    base_n = vertex_normals(base, faces)

    variants = {
        "height_up": dict(height=1.0), "height_down": dict(height=0.0),
        "weight_up": dict(weight=1.0), "weight_down": dict(weight=0.0),
        "chest_up": dict(local_chest=1.0), "chest_down": dict(local_chest=-1.0),
        "waist_up": dict(local_waist=1.0), "waist_down": dict(local_waist=-1.0),
        "hips_up": dict(local_hips=1.0), "hips_down": dict(local_hips=-1.0),
    }
    targets = []
    head_deltas = {}
    for tname, over in variants.items():
        v, h = rest_shape(model, g, **over)
        v = prep(v) - shift
        targets.append((tname, v - base, vertex_normals(v, faces) - base_n))
        head_deltas[tname] = np.round(prep(h) - shift - heads, 5).reshape(-1).tolist()

    path = OUT_DIR / f"anny-{name}.glb"
    joints, weights = skin_weights(model)
    parents = [int(p) for p in model.bone_parents]
    write_glb(path, base, base_n, faces, targets, (joints, weights, list(model.bone_labels), parents, heads))

    rings = find_rings(model, base)
    m0 = measure(base, faces, rings)
    per_target = {}
    for tname, dp, _ in targets:
        per_target[tname] = {k: round(val - m0[k], 5) for k, val in measure(base + dp, faces, rings).items()}

    print(f"{path.relative_to(ROOT)}: {path.stat().st_size / 1e6:.1f} MB, "
          f"рост {m0['height'] * 100:.1f} см, грудь {m0['chest'] * 100:.1f}, "
          f"талия {m0['waist'] * 100:.1f}, бёдра {m0['hips'] * 100:.1f}, масса {m0['mass']:.1f} кг")
    for tname, d in per_target.items():
        print(f"   {tname:12s} " + "  ".join(f"{k} {v * (1 if k == 'mass' else 100):+.1f}" for k, v in d.items()))

    return {
        "file": path.name,
        "parts": body_parts(model),
        "bones": {
            "names": list(model.bone_labels),
            "parents": parents,
            "heads": np.round(heads, 5).reshape(-1).tolist(),
            "headDeltas": head_deltas,
        },
        "targets": [t[0] for t in targets],
        "rings": rings,
        "base": {k: round(v, 5) for k, v in m0.items()},
        "deltas": per_target,
    }


def main() -> None:
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Собираю модель Anny (около минуты)…")
    model = build_model()
    faces = model.faces.cpu().numpy().astype(np.int64)

    meta = {
        "source": f"Anny {anny.__version__} (NAVER, Apache-2.0), MakeHuman base mesh",
        "units": "metres, Y up, face towards +Z, feet on y=0",
        "density": DENSITY,
        "partNames": [name for name, _ in PARTS],
        "genders": {name: export_gender(model, name, g, faces) for name, g in GENDERS.items()},
    }
    meta_path = OUT_DIR / "anny-meta.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    print(f"{meta_path.relative_to(ROOT)}: {meta_path.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
