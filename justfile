format:
  prettier --write .

check:
  prettier --check .

open:
  python3 -m http.server 9090 &
  sleep 0.3
  open http://localhost:9090

serve:
  python3 -m http.server 9090

