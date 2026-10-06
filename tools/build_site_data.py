"""Build data/*.json and audio/ for the site from the anonymized listening-test packages.

Inputs (none of them contain system names):
  --emos_package  E-MOS package dir: playlist.csv (trial,stimulus,reference), stimuli/, references/
  --nmos_package  NMOS package dir: playlist.csv (trial,stimulus,target), stimuli/
  --design        design export dir written by the private builder:
                    emos_design.json / nmos_design.json  {"n_groups", "targets": {stim_id: target_id},
                                                          "groups": [{"group", "orders": [[ids]]}]}
                    checks_manifest.json + checks/*.wav   attention checks and practice trials
  --headphone     dir from make_headphone_audio.py (tone.wav, digits_*.wav, digits.json)

Private answer-key folders are never read. Every WAV is rewritten with the stdlib `wave`
module, which keeps only the fmt and data chunks, so LIST/INFO metadata is dropped.

Usage: python -I tools/build_site_data.py --emos_package P --nmos_package P --design D --headphone H
       [--site .]
"""
import argparse
import csv
import json
import os
import shutil
import wave


def copy_wav(src, dst):
    with wave.open(src, "rb") as r:
        params = r.getparams()
        frames = r.readframes(r.getnframes())
    assert params.nchannels == 1 and params.sampwidth == 2, (src, params)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with wave.open(dst, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(params.framerate)
        w.writeframes(frames)


def stem(path):
    return os.path.splitext(os.path.basename(path))[0]


def build_test(test, pkg, design, site):
    rows = list(csv.DictReader(open(os.path.join(pkg, "playlist.csv"))))
    targets = design["targets"]
    trials = []
    for r in rows:
        sid = stem(r["stimulus"])
        dst = f"audio/{test}/{r['stimulus']}"
        copy_wav(os.path.join(pkg, r["stimulus"]), os.path.join(site, dst))
        t = {"trial_id": sid, "stimulus": dst, "target_id": targets[sid]}
        if r.get("reference"):
            rdst = f"audio/{test}/{r['reference']}"
            if not os.path.exists(os.path.join(site, rdst)):
                copy_wav(os.path.join(pkg, r["reference"]), os.path.join(site, rdst))
            t["reference"] = rdst
            t["reference_id"] = stem(r["reference"])
        trials.append(t)
    ids = {t["trial_id"] for t in trials}
    for g in design["groups"]:
        for order in g["orders"]:
            assert all(x.replace("#r", "") in ids for x in order), (test, g["group"])
    out = {"test": test, "n_groups": design["n_groups"], "trials": trials,
           "groups": design["groups"]}
    with open(os.path.join(site, f"data/{test}_trials.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    return len(trials)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--emos_package", required=True)
    ap.add_argument("--nmos_package", required=True)
    ap.add_argument("--design", required=True)
    ap.add_argument("--headphone", required=True)
    ap.add_argument("--site", default=".")
    a = ap.parse_args()

    for d in ("audio", "data"):
        shutil.rmtree(os.path.join(a.site, d), ignore_errors=True)
        os.makedirs(os.path.join(a.site, d))

    n = {}
    for test, pkg in (("emos", a.emos_package), ("nmos", a.nmos_package)):
        design = json.load(open(os.path.join(a.design, f"{test}_design.json")))
        n[test] = build_test(test, pkg, design, a.site)

    man = json.load(open(os.path.join(a.design, "checks_manifest.json")))
    for test in ("emos", "nmos"):
        for item in man[test]["checks"] + man[test]["practice"]:
            for k in ("stimulus", "reference"):
                if item.get(k):
                    dst = f"audio/checks/{os.path.basename(item[k])}"
                    copy_wav(os.path.join(a.design, item[k]), os.path.join(a.site, dst))
                    item[k] = dst
    hp = json.load(open(os.path.join(a.headphone, "digits.json")))
    copy_wav(os.path.join(a.headphone, "tone.wav"), os.path.join(a.site, "audio/checks/tone.wav"))
    for d in hp:
        dst = f"audio/checks/{os.path.basename(d['audio'])}"
        copy_wav(os.path.join(a.headphone, d["audio"]), os.path.join(a.site, dst))
        d["audio"] = dst
    man["headphone"] = {"tone": "audio/checks/tone.wav", "digits": hp}
    with open(os.path.join(a.site, "data/checks.json"), "w") as f:
        json.dump(man, f, indent=1)
    print(f"emos trials {n['emos']}, nmos trials {n['nmos']}, "
          f"checks emos {len(man['emos']['checks'])} nmos {len(man['nmos']['checks'])}")


if __name__ == "__main__":
    main()
