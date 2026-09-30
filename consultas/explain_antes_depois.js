/* ===========================================================================
 * ITEM (g) - CRIACAO DE INDICE COM PLANO DE EXECUCAO ANTES E DEPOIS
 *
 * O script executa, para cada base:
 *   1) explain("executionStats") da consulta SEM indice
 *   2) createIndex
 *   3) explain("executionStats") da MESMA consulta COM indice
 *   4) comparacao lado a lado
 *
 * Uso:  mongosh "mongodb://localhost:27017/brasil_bf" \
 *               --file consultas/explain_antes_depois.js
 * ======================================================================== */

load("consultas/util_saida.js");

/* --------------------------------------------------------------- auxiliares */

/** Percorre a arvore do plano vencedor e devolve a sequencia de estagios. */
function estagios(no, lista) {
  lista = lista || [];
  if (!no || typeof no !== "object") return lista;
  if (no.stage) lista.push(no.stage);
  ["inputStage", "queryPlan", "child"].forEach(function (chave) {
    if (no[chave]) estagios(no[chave], lista);
  });
  (no.inputStages || []).forEach(function (filho) { estagios(filho, lista); });
  return lista;
}

function resumo(explicacao) {
  const es = explicacao.executionStats;
  const plano = explicacao.queryPlanner.winningPlan;
  const cadeia = estagios(plano);
  return {
    plano: cadeia.join(" <- "),
    indice_usado: (JSON.stringify(plano).match(/"indexName":"([^"]+)"/) || [, "(nenhum)"])[1],
    tempo_ms: es.executionTimeMillis,
    documentos_examinados: es.totalDocsExamined,
    chaves_examinadas: es.totalKeysExamined,
    documentos_retornados: es.nReturned
  };
}

function mostrarResumo(rotulo, r) {
  print("");
  print(rotulo);
  print("  plano de execucao      : " + r.plano);
  print("  indice utilizado       : " + r.indice_usado);
  print("  tempo de execucao      : " + numero(r.tempo_ms) + " ms");
  print("  documentos examinados  : " + numero(r.documentos_examinados));
  print("  chaves de indice lidas : " + numero(r.chaves_examinadas));
  print("  documentos retornados  : " + numero(r.documentos_retornados));
}

function comparar(antes, depois) {
  const ganho = antes.tempo_ms / Math.max(depois.tempo_ms, 1);
  const reducao = antes.documentos_examinados > 0
    ? 100 * (1 - depois.documentos_examinados / antes.documentos_examinados) : 0;
  print("");
  print("COMPARACAO");
  const col = function (a, b, c) {
    return "  " + String(a).padEnd(22) + String(b).padStart(22) +
           String(c).padStart(22);
  };
  print(col("", "SEM INDICE", "COM INDICE"));
  print("  " + "-".repeat(66));
  print(col("plano (estagio final)", antes.plano.split(" <- ")[0],
            depois.plano.split(" <- ")[0]));
  print(col("tempo (ms)", numero(antes.tempo_ms), numero(depois.tempo_ms)));
  print(col("docs examinados", numero(antes.documentos_examinados),
            numero(depois.documentos_examinados)));
  print(col("chaves examinadas", numero(antes.chaves_examinadas),
            numero(depois.chaves_examinadas)));
  print(col("docs retornados", numero(antes.documentos_retornados),
            numero(depois.documentos_retornados)));
  print("");
  print("  ganho de tempo             : " + numero(ganho, 1) + "x mais rapido");
  print("  reducao de docs examinados : " + numero(reducao, 2) + "%");
  print("  seletividade antes  (retornados / examinados): " +
        (antes.documentos_examinados
          ? numero(100 * antes.documentos_retornados / antes.documentos_examinados, 4) + "%"
          : "-"));
  print("  seletividade depois (retornados / examinados): " +
        (depois.documentos_examinados
          ? numero(100 * depois.documentos_retornados / depois.documentos_examinados, 4) + "%"
          : "somente indice (0 documentos lidos)"));
}

/* =======================================================================
 * BASE 1 - pagamentos_bf
 * ==================================================================== */
titulo("ITEM (g) BASE 1 - indice { cod_ibge: 1, competencia: 1, valor: -1 }");

const COD_IBGE = 3509502;      // Campinas (SP)
const COMPETENCIA = 202608;
const INDICE_1 = "idx_municipio_competencia_valor";

print("");
print("CONSULTA ALVO (a mesma que o aplicativo executa ao abrir a ficha de um");
print("municipio): as parcelas pagas em um municipio em uma competencia,");
print("ordenadas da maior para a menor.");
print("");
print("  db.pagamentos_bf");
print("    .find({ cod_ibge: " + COD_IBGE + ", competencia: " + COMPETENCIA + " })");
print("    .sort({ valor: -1 })");
print("");
print("Total de documentos na colecao: " +
      numero(db.pagamentos_bf.estimatedDocumentCount()));

function consultaAlvo1() {
  return db.pagamentos_bf
           .find({ cod_ibge: COD_IBGE, competencia: COMPETENCIA })
           .sort({ valor: -1 });
}

subtitulo("1) Removendo o indice, se existir de execucao anterior");
try { db.pagamentos_bf.dropIndex(INDICE_1); print("  indice removido"); }
catch (e) { print("  indice ainda nao existia (" + e.codeName + ")"); }

subtitulo("2) PLANO ANTES DO INDICE");
const antes1 = resumo(consultaAlvo1().explain("executionStats"));
mostrarResumo("SEM INDICE:", antes1);

subtitulo("3) Criando o indice composto");
const t0 = Date.now();
db.pagamentos_bf.createIndex({ cod_ibge: 1, competencia: 1, valor: -1 },
                             { name: INDICE_1 });
print("  indice '" + INDICE_1 + "' criado em " +
      numero((Date.now() - t0) / 1000, 1) + " s");

subtitulo("4) PLANO DEPOIS DO INDICE");
const depois1 = resumo(consultaAlvo1().explain("executionStats"));
mostrarResumo("COM INDICE:", depois1);

comparar(antes1, depois1);

print("");
print("g1) HOUVE MELHORA? Sim, e de ordem de grandeza.");
print("g2) POR QUE?");
print("  Sem indice o MongoDB só tem um caminho: COLLSCAN, ou seja, ler os");
print("  " + numero(antes1.documentos_examinados) + " documentos da colecao um a um para");
print("  testar o filtro, e depois ainda ordenar em memoria (estagio SORT).");
print("  Com o indice composto { cod_ibge, competencia, valor } as chaves estao");
print("  fisicamente ordenadas na arvore B, entao o servidor desce direto ao");
print("  ponto em que cod_ibge e competencia batem (IXSCAN) e le apenas as");
print("  " + numero(depois1.chaves_examinadas) + " chaves daquele intervalo. A ordem dos campos");
print("  no indice segue a regra igualdade -> ordenacao: cod_ibge e competencia");
print("  entram por igualdade e valor:-1 ja devolve as parcelas ordenadas, o que");
print("  elimina o estagio de ordenacao em memoria.");

/* =======================================================================
 * BASE 2 - municipios_ibge (consulta coberta)
 * ==================================================================== */
titulo("ITEM (g) BASE 2 - indice { uf_sigla: 1, populacao_2026: -1, nome: 1 }");

const INDICE_2 = "idx_uf_populacao_nome";

print("");
print("CONSULTA ALVO: os municipios de um estado, do mais populoso para o menos,");
print("projetando apenas nome e populacao (sem o _id).");
print("");
print("  db.municipios_ibge");
print("    .find({ uf_sigla: \"SP\" }, { _id: 0, nome: 1, populacao_2026: 1 })");
print("    .sort({ populacao_2026: -1 })");
print("");
print("Total de documentos na colecao: " +
      numero(db.municipios_ibge.estimatedDocumentCount()));

function consultaAlvo2() {
  return db.municipios_ibge
           .find({ uf_sigla: "SP" }, { _id: 0, nome: 1, populacao_2026: 1 })
           .sort({ populacao_2026: -1 });
}

subtitulo("1) Removendo o indice, se existir de execucao anterior");
try { db.municipios_ibge.dropIndex(INDICE_2); print("  indice removido"); }
catch (e) { print("  indice ainda nao existia (" + e.codeName + ")"); }

subtitulo("2) PLANO ANTES DO INDICE");
const antes2 = resumo(consultaAlvo2().explain("executionStats"));
mostrarResumo("SEM INDICE:", antes2);

subtitulo("3) Criando o indice composto");
db.municipios_ibge.createIndex({ uf_sigla: 1, populacao_2026: -1, nome: 1 },
                               { name: INDICE_2 });
print("  indice '" + INDICE_2 + "' criado");

subtitulo("4) PLANO DEPOIS DO INDICE");
const depois2 = resumo(consultaAlvo2().explain("executionStats"));
mostrarResumo("COM INDICE:", depois2);

comparar(antes2, depois2);

print("");
print("g1) HOUVE MELHORA? Sim, mas o ganho de tempo absoluto e pequeno - e isso");
print("    e esperado.");
print("g2) POR QUE?");
print("  A colecao tem apenas " + numero(db.municipios_ibge.estimatedDocumentCount()) +
      " documentos e cabe inteira em memoria, logo");
print("  um COLLSCAN ja custava poucos milissegundos. O que o indice muda de");
print("  fato aqui e a QUANTIDADE DE TRABALHO: em vez de examinar todos os");
print("  documentos e ordenar em memoria, o servidor le apenas as chaves da UF");
print("  pedida, ja na ordem da populacao.");
print("  Alem disso a projecao pede exatamente campos que estao no indice");
print("  (uf_sigla, populacao_2026, nome) e exclui o _id: o plano vira");
print("  PROJECTION_COVERED e documentos examinados cai para ZERO - a resposta");
print("  sai apenas do indice, sem tocar nos documentos. E o caso de consulta");
print("  coberta (covered query).");
print("  Licao geral: indice compensa quando reduz documentos examinados; o");
print("  beneficio em tempo cresce com o tamanho da colecao, e por isso ele e");
print("  dramatico na base de 57 milhoes de pagamentos e modesto nesta.");
print("");

titulo("INDICES EXISTENTES APOS O ITEM (g)");
["pagamentos_bf", "municipios_ibge"].forEach(function (colecao) {
  print("");
  print(colecao + ":");
  db.getCollection(colecao).getIndexes().forEach(function (idx) {
    print("  " + idx.name.padEnd(36) + JSON.stringify(idx.key));
  });
});
print("");
