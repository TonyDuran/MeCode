# Provisioning NOT run by the app. Build once with network access you are authorized to use:
#   docker build -t mecode-engine:v2 engine/
# Base: python:3.14-slim, pinned by the digest present locally (pulled by Metis, T04).
FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs g++ gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/* \
 && python3 --version && node --version && g++ --version | head -1 && gcc --version | head -1
COPY runner.py adapters.py /opt/mecode/
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["python3", "-I", "/opt/mecode/runner.py"]
