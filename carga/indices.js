/* ===========================================================================
 * INDICES DE APOIO AS CONSULTAS, AO NOTEBOOK E AO APLICATIVO
 *
 * O indice exigido pelo item (g) e criado dentro de
 * consultas/explain_antes_depois.js, para que o plano "antes" seja legitimo.
 * Este script cria os demais e lista tudo com o tamanho ocupado.
 *
 * Uso:  mongosh "mongodb://localhost:27017/brasil_bf" --file carga/indices.js
 * ======================================================================== */

function titulo(texto) {
  print("");
  print("=".repeat(84));
  print(" " + texto);
  print("=".repeat(84));
}

function criar(colecao, chaves, opcoes) {
  const inicio = Date.now();
  const nome = db.getCollection(colecao).createIndex(chaves, opcoes);
  print("  " + colecao.padEnd(20) + JSON.stringify(chaves).padEnd(52) +
        ((Date.now() - inicio) / 1000).toFixed(1) + "s  -> " + nome);
}

titulo("CRIACAO DOS INDICES");
print("");

// --- BASE 1 ---------------------------------------------------------------
// Ficha do municipio (usada pelo aplicativo e pelo item g).
criar("pagamentos_bf", { cod_ibge: 1, competencia: 1, valor: -1 },
      { name: "idx_municipio_competencia_valor" });
// Agregacoes por estado e mes (consulta 1 e graficos).
criar("pagamentos_bf", { uf: 1, competencia: 1 },
      { name: "idx_uf_competencia" });
// Separacao entre parcela do mes e parcela retroativa (consulta 1 e grafico 4).
criar("pagamentos_bf", { competencia: 1, referencia: 1 },
      { name: "idx_competencia_referencia" });

// --- BASE 2 ---------------------------------------------------------------
// Consulta coberta do item (g).
criar("municipios_ibge", { uf_sigla: 1, populacao_2026: -1, nome: 1 },
      { name: "idx_uf_populacao_nome" });
// Cruzamento por nome normalizado (chave usada na integracao das bases).
criar("municipios_ibge", { nome_norm: 1, uf_sigla: 1 },
      { name: "idx_nome_norm_uf", unique: true });
// Rankings por riqueza do municipio.
criar("municipios_ibge", { pib_per_capita: -1 }, { name: "idx_pib_per_capita" });
// Busca textual por nome de cidade no aplicativo, com dicionario portugues.
criar("municipios_ibge", { nome: "text" },
      { name: "idx_texto_nome", default_language: "portuguese" });

// Serie historica: uma linha por municipio e ano.
criar("pib_serie_ibge", { cod_ibge: 1, ano: 1 },
      { name: "idx_municipio_ano", unique: true });
criar("pib_serie_ibge", { ano: 1, pib_mil_reais: -1 }, { name: "idx_ano_pib" });

// Tabela de integracao entre as duas bases.
criar("de_para_siafi_ibge", { uf: 1, cod_siafi: 1 },
      { name: "idx_uf_siafi", unique: true });
criar("de_para_siafi_ibge", { cod_ibge: 1 }, { name: "idx_cod_ibge" });

titulo("INDICES DO BANCO E ESPACO OCUPADO");
db.getCollectionNames().sort().forEach(function (colecao) {
  const col = db.getCollection(colecao);
  if (colecao.startsWith("system.")) return;
  const tamanhos = col.stats().indexSizes || {};
  print("");
  print(colecao + "  (" + (col.stats().storageSize / 1048576).toFixed(1) +
        " MB de dados)");
  col.getIndexes().forEach(function (idx) {
    const mb = tamanhos[idx.name] ? (tamanhos[idx.name] / 1048576).toFixed(1) : "?";
    print("  " + idx.name.padEnd(36) + JSON.stringify(idx.key).padEnd(50) +
          mb.padStart(9) + " MB");
  });
});
print("");
