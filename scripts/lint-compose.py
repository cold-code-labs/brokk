#!/usr/bin/env python3
"""Lint de compose: healthcheck caro e servico sem reaper.

As tres regras nasceram do incidente da surtr em 2026-08-24, onde o host ficou
em load 14 com a CPU em 50% -- carga invisivel no `top`, porque 63% de toda
criacao de processo era `runc` de healthcheck e os processos ja morriam antes
da amostragem.

  HC001 erro   interval < 15s sem start_interval -> storm de runc
  HC002 aviso  probe que sobe runtime (node -e / python -c) quando ha alternativa
  HC003 aviso  servico Node com healthcheck e sem `init: true`

Nao reprova (aprendido na propria auditoria):
  - interval curto ACOMPANHADO de start_interval: e o padrao recomendado
    (boot rapido, regime permanente barato) -- foi o que aplicamos na frota.
  - `node -e` em imagem slim: node:22-slim nao traz wget nem curl, entao o
    probe via fetch e a unica opcao sem mexer na imagem. So avisa se a imagem
    for alpine/debian completa, onde wget existe.
  - init em servico que nao e Node: Postgres/Redis fazem reap dos proprios
    filhos; a regra so vale para runtime que nao colhe processo reparented.

Uso: lint-compose.py <arquivo.yml> [...]    Exit 1 se houver erro.
"""
import io, re, sys, yaml

MIN_INTERVAL = 15
erro = 0

def secs(v):
    m = re.match(r'^\s*(\d+)\s*([smh]?)\s*$', str(v or ''))
    if not m: return None
    return int(m.group(1)) * {'s': 1, 'm': 60, 'h': 3600}[m.group(2) or 's']

def img_de(svc):
    i = svc.get('image')
    if isinstance(i, str): return i
    b = svc.get('build')
    if isinstance(b, dict): return str(b.get('dockerfile') or '')
    return str(b or '')

def eh_node(svc):
    s = (img_de(svc) + ' ' + str(svc.get('command') or '')).lower()
    return 'node' in s

def tem_wget(svc):
    """slim/distroless nao trazem wget; alpine (busybox) e debian completo trazem."""
    i = img_de(svc).lower()
    if 'slim' in i or 'distroless' in i: return False
    return 'alpine' in i or bool(i)

def check(path):
    global erro
    try:
        doc = yaml.safe_load(io.open(path, encoding='utf-8'))
    except Exception as e:
        print('%s: NAO PARSEAVEL (%s)' % (path, e)); return
    if not isinstance(doc, dict): return
    for nome, svc in (doc.get('services') or {}).items():
        if not isinstance(svc, dict): continue
        hc = svc.get('healthcheck') or {}
        if not hc or hc.get('disable'): continue

        iv, si = secs(hc.get('interval')), secs(hc.get('start_interval'))
        if iv is not None and iv < MIN_INTERVAL and si is None:
            print('%s: %s: HC001 erro  interval=%s sem start_interval '
                  '(use interval: 30s + start_interval: 2s)' % (path, nome, hc.get('interval')))
            erro = 1

        t = hc.get('test')
        if t:
            t = ' '.join(t) if isinstance(t, list) else str(t)
            if re.search(r'\bnode -e\b|\bpython3? -c\b', t) and tem_wget(svc):
                print('%s: %s: HC002 aviso probe sobe runtime e a imagem tem wget' % (path, nome))

        if eh_node(svc) and svc.get('init') is not True:
            print('%s: %s: HC003 aviso servico Node sem init:true '
                  '(PID 1 nao faz reap -> zumbis)' % (path, nome))

for p in sys.argv[1:]:
    check(p)
sys.exit(erro)
