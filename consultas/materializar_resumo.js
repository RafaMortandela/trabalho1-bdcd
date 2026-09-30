/* ===========================================================================
 * VISAO MATERIALIZADA COM $merge
 *
 * As agregacoes das 57 milhoes de parcelas levam minutos. Como o aplicativo e
 * os graficos sempre precisam dos mesmos numeros por municipio e competencia,
 * o resultado e calculado UMA vez e gravado em resumo_municipio_competencia,
 * usando o estagio $merge (visao materializada do MongoDB).
 *
 * Resultado: 5.570 municipios x 3 competencias = ~16,7 mil documentos, que o
 * aplicativo consulta em milissegundos.
 *
 * Uso:  mongosh "mongodb://localhost:27017/brasil_bf" \
 *               --file consultas/materializar_resumo.js
 * ======================================================================== */

load("consultas/util_saida.js");

const DESTINO = "resumo_municipio_competencia";

titulo("VISAO MATERIALIZADA " + DESTINO);
print("");
print("Origem : pagamentos_bf (" + numero(db.pagamentos_bf.estimatedDocumentCount()) +
      " documentos)");
print("Destino: " + DESTINO);

const pipeline = [
  // 1) Um grupo por municipio e competencia.
  { $group: {
      _id: { cod_ibge: "$cod_ibge", competencia: "$competencia" },
      total_pago: { $sum: "$valor" },
      parcelas: { $sum: 1 },
      parcelas_regulares: {
        $sum: { $cond: [{ $eq: ["$retroativo", false] }, 1, 0] } },
      parcelas_retroativas: {
        $sum: { $cond: [{ $eq: ["$retroativo", true] }, 1, 0] } },
      valor_retroativo: {
        $sum: { $cond: [{ $eq: ["$retroativo", true] }, "$valor", 0] } },
      valor_medio_parcela: { $avg: "$valor" },
      maior_parcela: { $max: "$valor" },
      menor_parcela: { $min: "$valor" }
  } },

  // 2) Atributos do IBGE (a outra base) para permitir normalizar por populacao.
  { $lookup: { from: "municipios_ibge", localField: "_id.cod_ibge",
               foreignField: "_id", as: "m" } },
  { $unwind: "$m" },

  // 3) Indicadores derivados, ja prontos para o aplicativo.
  { $addFields: {
      familias_por_100_hab: { $cond: [
        { $gt: ["$m.populacao_2026", 0] },
        { $multiply: [100, { $divide: ["$parcelas_regulares", "$m.populacao_2026"] }] },
        null] },
      valor_per_capita: { $cond: [
        { $gt: ["$m.populacao_2026", 0] },
        { $divide: ["$total_pago", "$m.populacao_2026"] }, null] },
      peso_no_pib_pct: { $cond: [
        { $gt: ["$m.pib_2023_mil_reais", 0] },
        { $multiply: [100, { $divide: [{ $multiply: ["$total_pago", 12] },
                                       { $multiply: ["$m.pib_2023_mil_reais", 1000] }] }] },
        null] }
  } },

  { $project: {
      _id: { $concat: [{ $toString: "$_id.cod_ibge" }, "-",
                       { $toString: "$_id.competencia" }] },
      cod_ibge: "$_id.cod_ibge",
      competencia: "$_id.competencia",
      municipio: "$m.nome",
      uf: "$m.uf_sigla",
      regiao: "$m.regiao",
      mesorregiao: "$m.mesorregiao",
      populacao: "$m.populacao_2026",
      pib_per_capita: "$m.pib_per_capita",
      pib_mil_reais: "$m.pib_2023_mil_reais",
      participacao_adm_publica: "$m.participacao_adm_publica",
      total_pago: 1, parcelas: 1, parcelas_regulares: 1, parcelas_retroativas: 1,
      valor_retroativo: 1, valor_medio_parcela: 1, maior_parcela: 1,
      menor_parcela: 1, familias_por_100_hab: 1, valor_per_capita: 1,
      peso_no_pib_pct: 1
  } },

  // 4) Grava (ou substitui) os documentos na colecao de destino.
  { $merge: { into: DESTINO, on: "_id",
              whenMatched: "replace", whenNotMatched: "insert" } }
];

mostrarPipeline(pipeline);

print("");
print("Executando (percorre a colecao inteira uma vez)...");
const inicio = Date.now();
db.pagamentos_bf.aggregate(pipeline, { allowDiskUse: true }).toArray();
const segundos = (Date.now() - inicio) / 1000;
print("Concluido em " + numero(segundos, 1) + " s");

print("");
print("Documentos em " + DESTINO + ": " + numero(db.getCollection(DESTINO).countDocuments({})));

db.getCollection(DESTINO).createIndex({ competencia: 1, uf: 1 },
                                      { name: "idx_competencia_uf" });
db.getCollection(DESTINO).createIndex({ competencia: 1, familias_por_100_hab: -1 },
                                      { name: "idx_competencia_dependencia" });
db.getCollection(DESTINO).createIndex({ cod_ibge: 1, competencia: 1 },
                                      { name: "idx_municipio_competencia", unique: true });
print("Indices da visao materializada criados");

subtitulo("Amostra: os 10 municipios com maior proporcao de familias atendidas");
const amostra = db.getCollection(DESTINO).find(
  { competencia: 202608, populacao: { $gte: 20000 } },
  { _id: 0, municipio: 1, uf: 1, populacao: 1, parcelas_regulares: 1,
    familias_por_100_hab: 1, valor_per_capita: 1 }
).sort({ familias_por_100_hab: -1 }).limit(10).toArray();

tabela([
  { rotulo: "Municipio", campo: "municipio", largura: 26 },
  { rotulo: "UF", campo: "uf", largura: 3 },
  { rotulo: "Populacao", campo: "populacao", largura: 11, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Familias", campo: "parcelas_regulares", largura: 10, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Fam./100 hab", campo: "familias_por_100_hab", largura: 12, alinha: "d",
    formato: v => numero(v, 2) },
  { rotulo: "Pago/hab", campo: "valor_per_capita", largura: 12, alinha: "d",
    formato: v => reais(v, 2) }
], amostra);

print("");
print("Ganho: a mesma pergunta que exigia varrer 57 milhoes de documentos agora");
print("e respondida por uma consulta indexada sobre ~16,7 mil documentos.");
print("");
