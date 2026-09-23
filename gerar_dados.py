#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gerar_dados.py, regenera os JSONs de dados oficiais do AutoCusto BR.

    pip install pdfplumber pandas
    python gerar_dados.py --pbev "Tabela PBEV 2026_20_JAN-REV04.pdf" \
                          --wltp Euro_6_latest.csv \
                          --out ./dados

Cada fonte e opcional: passe so --pbev para regerar o Brasil, so --wltp para
regerar a Uniao Europeia, ou os dois.

FONTES
  Brasil: PDF do PBEV, Inmetro, gov.br/inmetro. Publicado com revisoes ao
          longo do ano (JAN-REV04, JUN, AGO...). Use sempre a mais recente.
  UE:     CSV Euro 6 da VCA, carfueldata.vehicle-certification-agency.gov.uk.
          Publicado uma vez por ano.

POR QUE pdfplumber E NAO pypdf
  O pypdf embaralha as colunas da tabela do Inmetro, o que gera consumo
  trocado entre gasolina e etanol. O pdfplumber preserva a grade, e por isso
  a extracao depende da linha ter exatamente 28 colunas.
"""

import argparse
import json
from collections import Counter
from pathlib import Path


# ══════════════════════════════════════════════════════════════════════════
#  BRASIL, PBEV Inmetro
# ══════════════════════════════════════════════════════════════════════════

PBEV_COLUNAS = 28  # a tabela do Inmetro; linha com outro tamanho nao e dado

TIPO_MAP = {
    'Combustão': 'ICE',  'Combustao': 'ICE',
    'Híbrido':   'HEV',  'Hibrido':   'HEV',
    'Plug-in':   'PHEV', 'Plug-In':   'PHEV',
    'Elétrico':  'BEV',  'Eletrico':  'BEV',
}
COMB_MAP = {'E': 'Etanol', 'G': 'Gasolina', 'F': 'Flex', 'D': 'Diesel'}


def _num(s):
    """Numero da celula do PDF. Vazio, barra, ND e traco viram None."""
    s = (s or '').strip()
    if not s or s in ('\\', 'ND', '-'):
        return None
    try:
        return float(s.replace(',', '.'))
    except ValueError:
        return None


def _txt(s):
    return ' '.join((s or '').split())


COMB_VALIDOS = {'Etanol', 'Gasolina', 'Flex', 'Diesel', 'Elétrico'}
TIPOS_VALIDOS = {'ICE', 'HEV', 'PHEV', 'BEV'}


def _conferir_sanidade_pbev(registros, pdf_path):
    """
    Barra a gravacao quando a extracao saiu embaralhada.

    A grade de 28 colunas so vale para o layout do PDF de janeiro de 2026.
    Medido em 23/09/2026: o mesmo codigo rodado nos PDFs de junho e de agosto
    devolve linhas com marca duplicada e modelo trocado ('AUDI AUDI SQ6
    Sportback e-tron Quattro Q7 - S Line'), codigos de combustivel que nao
    existem ('E100', 'F\\nF') e cerca de metade dos registros a menos.

    Sem esta conferencia, esse lixo era gravado por cima de dados/pbev.json
    sem um aviso sequer, o que e pior do que nao ter script nenhum: o app
    passaria a comparar veiculos com consumo de outro carro.
    """
    problemas = []

    combs = Counter(e['combustivel'] for e in registros)
    invalidos = {c: n for c, n in combs.items() if c not in COMB_VALIDOS}
    if invalidos:
        problemas.append('combustiveis fora do esperado: %r' % invalidos)

    tipos = Counter(e['tipo'] for e in registros)
    tipos_inv = {t: n for t, n in tipos.items() if t not in TIPOS_VALIDOS}
    if tipos_inv:
        problemas.append('tipos fora do esperado: %r' % tipos_inv)

    # Coluna deslocada faz a marca virar 'AUDI AUDI' ou 'CHEVROLET FIAT'.
    repetidos = [e for e in registros
                 if len(e['marca'].split()) > 1
                 and len(set(e['marca'].upper().split())) < len(e['marca'].split())]
    if repetidos:
        problemas.append('%d registros com marca repetida, ex: %r'
                         % (len(repetidos), repetidos[0]['marca']))

    vazios = [e for e in registros if not e['consumo']]
    if registros and len(vazios) / len(registros) > 0.02:
        problemas.append('%d de %d registros sem consumo nenhum'
                         % (len(vazios), len(registros)))

    if problemas:
        raise SystemExit(
            'ERRO: a extracao de %s saiu embaralhada, NADA foi gravado.\n' % pdf_path
            + ''.join('  - %s\n' % p for p in problemas)
            + '\nO layout deste PDF nao bate com a grade de %d colunas esperada.\n'
              'Inspecione a tabela real antes de ajustar:\n'
              '  import pdfplumber\n'
              '  with pdfplumber.open(PDF) as pdf:\n'
              '      for t in pdf.pages[3].extract_tables():\n'
              '          print(len(t[0]), t[0]); print(t[1])\n'
              'Depois corrija PBEV_COLUNAS e os indices em gerar_pbev().\n'
            % PBEV_COLUNAS
        )


def gerar_pbev(pdf_path):
    import pdfplumber

    linhas = []
    with pdfplumber.open(pdf_path) as pdf:
        for pagina in pdf.pages:
            for tabela in pagina.extract_tables():
                for linha in tabela:
                    if not linha or linha[0] in ('Categoria', None):
                        continue
                    if len(linha) != PBEV_COLUNAS:
                        continue
                    linhas.append(linha)

    if not linhas:
        raise SystemExit(
            'ERRO: nenhuma linha de %d colunas encontrada em %s.\n'
            'O layout da tabela do Inmetro provavelmente mudou. Confira o numero\n'
            'de colunas com: pdfplumber.open(pdf).pages[N].extract_tables()'
            % (PBEV_COLUNAS, pdf_path)
        )

    registros = []
    for r in linhas:
        tipo = TIPO_MAP.get((r[5] or '').strip(), (r[5] or '').strip())
        combustivel = ('Elétrico' if tipo == 'BEV'
                       else COMB_MAP.get((r[9] or '').strip(), (r[9] or '').strip()))

        etanol   = (_num(r[17]), _num(r[18]))
        fossil   = (_num(r[19]), _num(r[20]))   # gasolina ou diesel
        eletrico = (_num(r[21]), _num(r[22]))
        autonomia = _num(r[24])

        consumo = {}
        if None not in etanol:
            consumo['etanol'] = {'cidade': etanol[0], 'estrada': etanol[1], 'unidade': 'km/L'}
        if None not in fossil:
            chave = 'diesel' if combustivel == 'Diesel' else 'gasolina'
            consumo[chave] = {'cidade': fossil[0], 'estrada': fossil[1], 'unidade': 'km/L'}
        if None not in eletrico:
            # km/Le, quilometro por litro equivalente, como o Inmetro publica.
            consumo['eletrico'] = {'cidade': eletrico[0], 'estrada': eletrico[1], 'unidade': 'km/Le'}

        entrada = {
            'fonte': 'PBEV Inmetro',
            'regiao': 'BR',
            'categoria': _txt(r[0]),
            'marca': _txt(r[1]),
            'modelo': _txt(r[2]),
            'versao': _txt(r[3]),
            'motor': _txt(r[4]),
            'tipo': tipo,
            'combustivel': combustivel,
            'consumo': consumo,
        }
        if autonomia is not None:
            entrada['autonomia_eletrica_km'] = autonomia
        # Assinatura do irmao tecnico: mesmo motor, transmissao e emissoes.
        entrada['_sig'] = (entrada['marca'], entrada['modelo'], entrada['motor'],
                           r[6], tuple(r[10:16]))
        registros.append(entrada)

    # O PDF traz celulas de consumo em branco em algumas versoes, glitch de
    # extracao. O registro irmao de mesma ficha tecnica tem os mesmos numeros.
    por_sig = {}
    for e in registros:
        por_sig.setdefault(e['_sig'], []).append(e)
    preenchidos = 0
    for e in registros:
        if e['consumo']:
            continue
        for irmao in por_sig.get(e['_sig'], []):
            if irmao is not e and irmao['consumo']:
                e['consumo'] = json.loads(json.dumps(irmao['consumo']))
                preenchidos += 1
                break
    for e in registros:
        del e['_sig']

    # O PDF repete linhas identicas; mantem a primeira ocorrencia.
    vistos, saida = set(), []
    for e in registros:
        chave = json.dumps(e, sort_keys=True, ensure_ascii=False)
        if chave in vistos:
            continue
        vistos.add(chave)
        saida.append(e)

    _conferir_sanidade_pbev(saida, pdf_path)

    vazios = [e for e in saida if not e['consumo']]
    print('  PBEV: %d registros, %d duplicados removidos, %d preenchidos a partir de irmao, %d sem consumo'
          % (len(saida), len(registros) - len(saida), preenchidos, len(vazios)))
    print('    tipos: %s' % dict(Counter(e['tipo'] for e in saida)))
    print('    combustiveis: %s' % dict(Counter(e['combustivel'] for e in saida)))
    for e in vazios[:5]:
        print('    sem consumo: %s %s %s' % (e['marca'], e['modelo'], e['versao']))
    return saida


# ══════════════════════════════════════════════════════════════════════════
#  UNIAO EUROPEIA, WLTP / VCA
# ══════════════════════════════════════════════════════════════════════════
#
# ATENCAO, esta metade NAO foi validada contra o CSV real.
#
# O gerar_dados.py original se perdeu, e o CSV da VCA nao estava no disco na
# reconstrucao de 23/09/2026. A metade PBEV acima foi recuperada de um script
# irmao e confere registro a registro com dados/pbev.json. Esta aqui foi
# deduzida a partir da forma do dados/wltp.json ja gerado.
#
# O ponto que obrigou a deducao: a coluna 'Fuel Type' NAO determina o tipo.
# No wltp.json atual, 'Petrol Electric' aparece como HEV em 651 registros e
# como ICE em 620, o que so se explica por uma coluna de powertrain separando
# hibrido cheio de mild hybrid. Por isso o tipo sai de POWERTRAIN_MAP abaixo.
#
# Como o mapeamento e deducao, esta metade FALHA ALTO quando encontra um valor
# que nao conhece, em vez de gravar dado errado em silencio. Se o primeiro uso
# reclamar, ajuste POWERTRAIN_MAP e confira o resultado contra o wltp.json
# anterior antes de substituir.

WLTP_COLUNAS = {
    'marca':       ['manufacturer', 'make'],
    'modelo':      ['model'],
    'versao':      ['description', 'variant'],
    'combustivel': ['fuel type', 'fuel'],
    'powertrain':  ['powertrain'],
    'combinado':   ['wltp metric combined', 'metric combined', 'combined (l/100km)'],
    'wh_km':       ['wh/km', 'electric energy consumption wh/km'],
    'autonomia':   ['maximum range (km)', 'electric range (km)', 'range (km)'],
}

# Ordem importa: 'plug-in hybrid' tem de ser testado antes de 'hybrid', e
# 'mild hybrid' antes de 'hybrid electric', senao o casamento parcial erra.
POWERTRAIN_MAP = [
    ('plug-in hybrid', 'PHEV'), ('phev', 'PHEV'),
    ('battery electric', 'BEV'), ('pure electric', 'BEV'), ('bev', 'BEV'),
    ('mild hybrid', 'ICE'), ('mhev', 'ICE'),   # mild hybrid conta como ICE
    ('hybrid electric', 'HEV'), ('hev', 'HEV'),
    ('internal combustion', 'ICE'), ('ice', 'ICE'),
]


def _achar_coluna(colunas, candidatos, obrigatoria=True, rotulo=''):
    norm = {str(c).strip().lower(): c for c in colunas}
    for cand in candidatos:
        if cand in norm:
            return norm[cand]
    for cand in candidatos:                      # casamento parcial
        for chave, original in norm.items():
            if cand in chave:
                return original
    if obrigatoria:
        raise SystemExit(
            'ERRO: coluna "%s" nao encontrada no CSV.\n'
            '  procurei por: %s\n'
            '  colunas do arquivo: %s\n'
            'Ajuste WLTP_COLUNAS em gerar_dados.py.'
            % (rotulo, candidatos, list(colunas))
        )
    return None


def _classificar(powertrain):
    p = str(powertrain or '').strip().lower()
    for chave, tipo in POWERTRAIN_MAP:
        if chave in p:
            return tipo
    return None


def gerar_wltp(csv_path):
    import pandas as pd

    df = pd.read_csv(csv_path, encoding='latin-1', low_memory=False)
    col = {k: _achar_coluna(df.columns, v,
                            obrigatoria=(k not in ('autonomia', 'wh_km')),
                            rotulo=k)
           for k, v in WLTP_COLUNAS.items()}

    def val(linha, chave):
        c = col.get(chave)
        if not c:
            return None
        v = linha.get(c)
        return None if pd.isna(v) else v

    def num(linha, chave):
        v = val(linha, chave)
        if v is None:
            return None
        try:
            return float(str(v).replace(',', '.'))
        except ValueError:
            return None

    registros, desconhecidos = [], Counter()
    for _, linha in df.iterrows():
        tipo = _classificar(val(linha, 'powertrain'))
        if tipo is None:
            desconhecidos[str(val(linha, 'powertrain'))] += 1
            continue

        consumo = {}
        combinado = num(linha, 'combinado')
        wh_km = num(linha, 'wh_km')
        if combinado is not None:
            # PHEV separa o consumo fossil do eletrico; ICE e HEV tem um so.
            chave = 'gasolina_combinado' if tipo == 'PHEV' else 'combinado'
            consumo[chave] = {'valor': combinado, 'unidade': 'L/100km'}
        if wh_km is not None:
            consumo['eletrico_wh_km'] = {'valor': wh_km, 'unidade': 'Wh/km'}

        autonomia = num(linha, 'autonomia')
        registros.append({
            'fonte': 'WLTP (VCA)',
            'regiao': 'EU',
            'marca': _txt(str(val(linha, 'marca') or '')),
            'modelo': _txt(str(val(linha, 'modelo') or '')),
            'versao': _txt(str(val(linha, 'versao') or '')),
            'tipo': tipo,
            'combustivel': _txt(str(val(linha, 'combustivel') or '')),
            'consumo': consumo,
            'autonomia_eletrica_km': autonomia if tipo in ('BEV', 'PHEV') else None,
        })

    if desconhecidos:
        raise SystemExit(
            'ERRO: valores de powertrain nao reconhecidos, nada foi gravado.\n'
            + ''.join('  %5d x %s\n' % (n, p) for p, n in desconhecidos.most_common())
            + 'Acrescente-os a POWERTRAIN_MAP em gerar_dados.py e rode de novo.'
        )

    vistos, saida = set(), []
    for e in registros:
        chave = json.dumps(e, sort_keys=True, ensure_ascii=False)
        if chave in vistos:
            continue
        vistos.add(chave)
        saida.append(e)

    print('  WLTP: %d registros, %d duplicados removidos'
          % (len(saida), len(registros) - len(saida)))
    print('    tipos: %s' % dict(Counter(e['tipo'] for e in saida)))
    return saida


# ══════════════════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(
        description='Regenera os JSONs de dados oficiais do AutoCusto BR.')
    ap.add_argument('--pbev', help='PDF da tabela PBEV do Inmetro (Brasil)')
    ap.add_argument('--wltp', help='CSV Euro 6 da VCA (Uniao Europeia)')
    ap.add_argument('--out', default='./dados', help='pasta de saida (padrao: ./dados)')
    args = ap.parse_args()

    if not args.pbev and not args.wltp:
        ap.error('informe ao menos --pbev ou --wltp')

    destino = Path(args.out)
    destino.mkdir(parents=True, exist_ok=True)

    for origem, gerador, nome in ((args.pbev, gerar_pbev, 'pbev.json'),
                                  (args.wltp, gerar_wltp, 'wltp.json')):
        if not origem:
            continue
        if not Path(origem).exists():
            raise SystemExit('ERRO: arquivo nao encontrado: %s' % origem)
        print('Lendo %s' % origem)
        dados = gerador(origem)
        alvo = destino / nome
        with open(alvo, 'w', encoding='utf-8') as f:
            json.dump(dados, f, ensure_ascii=False, indent=2)
        print('  gravado: %s\n' % alvo)


if __name__ == '__main__':
    main()
