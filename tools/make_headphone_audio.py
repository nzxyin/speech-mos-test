"""Generate the sound-check audio: a calibration tone and spoken digit sequences.

The digits are synthesized with espeak-ng (a formant synthesizer that is clearly not one of the
tested systems), spaced by 0.35 s of silence, and peak-normalized to -1 dBFS with sox. The tone
is a 1 s, 440 Hz sine with 50 ms fades at a level close to the RMS of the speech clips.

Usage: python -I tools/make_headphone_audio.py --out_dir DIR [--seed 7]
Needs: espeak-ng, sox.
"""
import argparse
import json
import os
import random
import subprocess

WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out_dir", required=True)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--n_seq", type=int, default=3)
    ap.add_argument("--length", type=int, default=4)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    os.makedirs(a.out_dir, exist_ok=True)
    tmp = os.path.join(a.out_dir, "_tmp")
    os.makedirs(tmp, exist_ok=True)

    subprocess.run(["sox", "-n", "-r", "16000", "-b", "16", "-c", "1",
                    os.path.join(a.out_dir, "tone.wav"), "synth", "1.0", "sine", "440",
                    "fade", "0.05", "1.0", "0.05", "gain", "-18"], check=True)
    sil = os.path.join(tmp, "sil.wav")
    subprocess.run(["sox", "-n", "-r", "16000", "-b", "16", "-c", "1", sil, "trim", "0", "0.35"],
                   check=True)
    out, seen = [], set()
    while len(out) < a.n_seq:
        digits = "".join(str(rng.randrange(10)) for _ in range(a.length))
        if digits in seen or len(set(digits)) < a.length - 1:
            continue
        seen.add(digits)
        parts = []
        for j, d in enumerate(digits):
            raw = os.path.join(tmp, f"{len(out)}_{j}_raw.wav")
            p = os.path.join(tmp, f"{len(out)}_{j}.wav")
            subprocess.run(["espeak-ng", "-v", "en-us", "-s", "140", "-w", raw, WORDS[int(d)]],
                           check=True)
            subprocess.run(["sox", raw, "-r", "16000", "-b", "16", "-c", "1", p,
                            "silence", "1", "0.01", "0.5%", "reverse", "silence", "1", "0.01",
                            "0.5%", "reverse"], check=True)
            parts += [p, sil]
        name = f"digits_{len(out) + 1}.wav"
        subprocess.run(["sox", sil, *parts, os.path.join(a.out_dir, name), "norm", "-1"], check=True)
        out.append({"audio": name, "answer": digits})
    for f in os.listdir(tmp):
        os.remove(os.path.join(tmp, f))
    os.rmdir(tmp)
    with open(os.path.join(a.out_dir, "digits.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(f"wrote tone.wav and {len(out)} digit sequences to {a.out_dir}")


if __name__ == "__main__":
    main()
