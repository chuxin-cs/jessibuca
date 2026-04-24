#!/usr/bin/env python3

from pathlib import Path
from subprocess import run
from shutil import which


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
OUTPUT = REPO_ROOT / "src" / "decoder" / "decoder"


SARGS = {
    "WASM": 1,
    "INITIAL_MEMORY": 67108864,
    "ASSERTIONS": 1,
    "ERROR_ON_UNDEFINED_SYMBOLS": 0,
    "DISABLE_EXCEPTION_CATCHING": 1,
    "INVOKE_RUN": 0,
    "USE_PTHREADS": 0,
    "ALLOW_MEMORY_GROWTH": 1,
    "ENVIRONMENT": "web,worker",
    "EXPORTED_RUNTIME_METHODS": "['HEAPU8','HEAPU32','HEAPF32']",
}


def build():
    emcc = which("emcc.bat") or which("emcc")
    if not emcc:
        raise RuntimeError("emcc was not found in PATH")

    emcc_args = [
        emcc,
        str(SCRIPT_DIR / "decoder.cpp"),
        str(SCRIPT_DIR / "obj" / "lib" / "libavcodec.a"),
        str(SCRIPT_DIR / "obj" / "lib" / "libavutil.a"),
        str(SCRIPT_DIR / "obj" / "lib" / "libswresample.a"),
        "-Oz",
        "--bind",
        "-I.",
        f"-I{SCRIPT_DIR / 'obj' / 'include'}",
        "--pre-js",
        str(SCRIPT_DIR / "pre.js"),
        "--post-js",
        str(SCRIPT_DIR / "post.js"),
    ]

    for key, value in SARGS.items():
        emcc_args.extend(["-s", f"{key}={value}"])

    emcc_args.extend(["-o", f"{OUTPUT}.js"])

    print("building...")
    run(emcc_args, cwd=SCRIPT_DIR, check=True)
    output_js = Path(f"{OUTPUT}.js")
    output_js.write_text(
        output_js.read_text(encoding="utf-8")
        .replace("node:fs", "fs")
        .replace("node:path", "path")
        .replace("node:crypto", "crypto"),
        encoding="utf-8",
    )
    print("done")


if __name__ == "__main__":
    build()
