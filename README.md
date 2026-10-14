# MeCode

MeCode is in the prototype stage, not a finished application. The current
artifact is a standard-library-only [trusted-fixture judge experiment](prototypes/trusted-judge/README.md).
It runs only inspected, fixed fixtures as host subprocesses. It is not a secure
sandbox: never connect learner/editor code or other untrusted submissions.

From the repository root, on a supported POSIX system with CPython 3.10+:

    python3 -B -W error -m unittest discover -s prototypes/trusted-judge -v

No dependency installation is needed. See the prototype README for the contract,
verified local runtime and limitations. The CI workflow runs this same bounded
prototype check on pull requests and pushes to main; no CI pass or full-product
coverage is claimed here.

Licensed under [Apache-2.0](LICENSE).
