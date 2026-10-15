# Provisioning NOT run by the app. Build once with network access you are authorized to use:
#   docker build -t mecode-engine:v2 engine/
# Base pinned by digest observed locally by Talos (T01): python 3.14.8 / Debian trixie.
FROM python@sha256:cfe2e24a75302a15934d37c2d86412893c0aa934dc3a97cbb439d04c01890ca9
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs g++ gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/* \
 && python3 --version && node --version && g++ --version | head -1 && gcc --version | head -1
COPY runner.py adapters.py /opt/mecode/
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["python3", "-I", "/opt/mecode/runner.py"]
