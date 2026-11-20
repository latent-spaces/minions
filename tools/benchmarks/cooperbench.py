"""Score a pair of existing patches with CooperBench's Docker evaluator."""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


UPSTREAM_REVISION = "63b9d44d9f39a02fccf5bf0052db48a917a011fd"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, required=True, help="Pinned CooperBench checkout")
    parser.add_argument("--output", type=Path, required=True, help="New directory for evaluator inputs and results")
    parser.add_argument("--repo", default="pallets_click_task")
    parser.add_argument("--task", type=int, default=2800)
    parser.add_argument("--features", type=int, nargs=2, default=(2, 6), metavar=("FIRST", "SECOND"))
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--reference", action="store_true", help="Use CooperBench's per-feature reference patches")
    source.add_argument("--patches", type=Path, nargs=2, metavar=("FIRST", "SECOND"), help="Git patches in feature order")
    args = parser.parse_args()

    checkout, output = args.checkout.resolve(), args.output.resolve()
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip()
    if revision != UPSTREAM_REVISION:
        parser.error(f"Use CooperBench at {UPSTREAM_REVISION}, found {revision}")
    if not args.repo.endswith("_task") or not args.repo.replace("_", "").isalnum():
        parser.error("--repo must be a CooperBench dataset directory name ending in _task")
    first, second = args.features
    if min(first, second) < 1 or first == second or args.task < 0:
        parser.error("Use two distinct positive feature IDs and a nonnegative task ID")

    dataset = checkout / "dataset"
    task = dataset / args.repo / f"task{args.task}"
    features = [task / f"feature{number}" for number in args.features]
    patches = [feature / "feature.patch" for feature in features] if args.reference else args.patches
    for path in [*patches, *(feature / "tests.patch" for feature in features)]:
        if not path.is_file():
            parser.error(f"Missing patch: {path}")

    output.mkdir(mode=0o700)
    run = output / "pair" / "coop" / args.repo / str(args.task) / f"f{first}_f{second}"
    run.mkdir(parents=True)
    for feature, patch in zip(args.features, patches):
        shutil.copyfile(patch, run / f"agent{feature}.patch")
    (run / "result.json").write_text(json.dumps({
        "setting": "coop",
        "source": "reference" if args.reference else "external",
        "cooperbench_revision": revision,
    }) + "\n", encoding="utf-8")

    subprocess.run([
        "uv", "run", "--project", str(checkout), "--frozen", "--no-dev", "--python", "3.12",
        "cooperbench", "eval", "--name", "pair", "--backend", "docker",
        "--dataset-dir", str(dataset), "--log-dir", str(output),
    ], cwd=output, check=True)

    report = run / "eval.json"
    result = json.loads(report.read_text(encoding="utf-8"))
    print(f"CooperBench report: {report}")
    if any(part.get("error") for part in (result, result["feature1"], result["feature2"])):
        return 2
    return 0 if result["both_passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"CooperBench evaluation failed: {error}", file=sys.stderr)
        sys.exit(2)
