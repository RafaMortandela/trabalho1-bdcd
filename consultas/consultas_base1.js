/* ===========================================================================
 * ITEM (f) - CONSULTAS COMPLEXAS NA BASE 1
 *            Novo Bolsa Familia / Portal da Transparencia
 *
 * Uso:  mongosh "mongodb://localhost:27017/brasil_bf" \
 *               --file consultas/consultas_base1.js
 * ======================================================================== */

load("consultas/util_saida.js");

const COMPETENCIA = 202608;   // mes de pagamento analisado

/* =======================================================================
 * CONSULTA 1
 * ==================================================================== */
titulo("BASE 1 / CONSULTA 1 - Onde o Novo Bolsa Familia pesa mais, por UF");
objetivo(
  "Ordenar as 27 unidades da federacao pelo valor pago por habitante na " +
  "competencia " + COMPETENCIA + ". A consulta cruza as duas bases: agrega os " +
  "pagamentos do Portal da Transparencia e busca populacao e PIB no cadastro " +
  "do IBGE com um $lookup correlacionado (subconsulta que ja soma a populacao " +
  "de todos os municipios da UF). Tambem separa o que foi pago no mes de " +
  "referencia corrente do que foi pago de forma retroativa.");

const pipeline1 = [
  { $match: { competencia: COMPETENCIA } },

  // Um grupo por UF: total pago, parcelas e separacao das retroativas.
  { $group: {
      _id: "$uf",
      total_pago: { $sum: "$valor" },
      parcelas: { $sum: 1 },
      parcelas_regulares: {
        $sum: { $cond: [{ $eq: ["$retroativo", false] }, 1, 0] } },
      parcelas_retroativas: {
        $sum: { $cond: [{ $eq: ["$retroativo", true] }, 1, 0] } },
      valor_retroativo: {
        $sum: { $cond: [{ $eq: ["$retroativo", true] }, "$valor", 0] } },
      valor_medio_parcela: { $avg: "$valor" },
      maior_parcela: { $max: "$valor" }
  } },

  // $lookup correlacionado: a subconsulta agrega o IBGE dentro da propria UF.
  { $lookup: {
      from: "municipios_ibge",
      let: { uf: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$uf_sigla", "$$uf"] } } },
        { $group: {
            _id: null,
            populacao: { $sum: "$populacao_2026" },
            pib_mil_reais: { $sum: "$pib_2023_mil_reais" },
            municipios: { $sum: 1 }
        } }
      ],
      as: "ibge"
  } },
  { $addFields: { ibge: { $first: "$ibge" } } },

  { $addFields: {
      valor_per_capita: { $divide: ["$total_pago", "$ibge.populacao"] },
      // Cada familia recebe uma parcela por mes de referencia, logo as
      // parcelas regulares equivalem as familias atendidas no mes.
      familias_por_100_hab: {
        $multiply: [100, { $divide: ["$parcelas_regulares", "$ibge.populacao"] }] },
      // Peso do programa na economia local, anualizando o mes observado.
      // O PIB do IBGE vem em mil reais, por isso o fator 1000.
      peso_no_pib_pct: {
        $multiply: [100, { $divide: [{ $multiply: ["$total_pago", 12] },
                                     { $multiply: ["$ibge.pib_mil_reais", 1000] }] }] }
  } },

  { $sort: { valor_per_capita: -1 } },
  { $project: {
      _id: 0, uf: "$_id", regiao_municipios: "$ibge.municipios",
      populacao: "$ibge.populacao", parcelas: 1, parcelas_regulares: 1,
      parcelas_retroativas: 1, total_pago: 1, valor_medio_parcela: 1,
      valor_per_capita: 1, familias_por_100_hab: 1, peso_no_pib_pct: 1
  } }
];

mostrarPipeline(pipeline1);
const r1 = executar("pagamentos_bf", pipeline1);

tabela([
  { rotulo: "UF", campo: "uf", largura: 3 },
  { rotulo: "Populacao", campo: "populacao", largura: 12, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Familias", campo: "parcelas_regulares", largura: 11, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Fam./100 hab", campo: "familias_por_100_hab", largura: 12, alinha: "d",
    formato: v => numero(v, 2) },
  { rotulo: "Total pago no mes", campo: "total_pago", largura: 19, alinha: "d",
    formato: v => reais(v, 0) },
  { rotulo: "Por habitante", campo: "valor_per_capita", largura: 13, alinha: "d",
    formato: v => reais(v, 2) },
  { rotulo: "% do PIB/ano", campo: "peso_no_pib_pct", largura: 12, alinha: "d",
    formato: v => numero(v, 2) + "%" }
], r1);

print("");
print("LEITURA DO RESULTADO: as primeiras linhas concentram os estados do Norte e");
print("do Nordeste, onde o programa transfere mais reais por habitante e responde");
print("por uma fatia maior do PIB local.");

/* =======================================================================
 * CONSULTA 2
 * ==================================================================== */
titulo("BASE 1 / CONSULTA 2 - Municipios mais dependentes e relacao com o PIB");
objetivo(
  "Responder duas perguntas em uma unica passada pela colecao, com $facet: " +
  "(1) quais municipios com pelo menos 20 mil habitantes tem a maior proporcao " +
  "de familias atendidas, e (2) como essa proporcao se comporta por faixa de " +
  "PIB per capita ($bucket). O recorte de 20 mil habitantes evita que " +
  "municipios minusculos dominem o ranking por efeito de escala.");

const pipeline2 = [
  { $match: { competencia: COMPETENCIA } },
  { $group: {
      _id: "$cod_ibge",
      total_pago: { $sum: "$valor" },
      parcelas_regulares: {
        $sum: { $cond: [{ $eq: ["$retroativo", false] }, 1, 0] } },
      valor_medio_parcela: { $avg: "$valor" }
  } },

  // Traz os atributos do IBGE pelo codigo do municipio (chave _id da colecao).
  { $lookup: { from: "municipios_ibge", localField: "_id",
               foreignField: "_id", as: "m" } },
  { $unwind: "$m" },
  { $match: { "m.populacao_2026": { $gte: 20000 } } },

  { $addFields: {
      municipio: "$m.nome",
      uf: "$m.uf_sigla",
      regiao: "$m.regiao",
      populacao: "$m.populacao_2026",
      pib_per_capita: "$m.pib_per_capita",
      familias_por_100_hab: {
        $multiply: [100, { $divide: ["$parcelas_regulares", "$m.populacao_2026"] }] },
      valor_per_capita: { $divide: ["$total_pago", "$m.populacao_2026"] }
  } },

  { $facet: {
      mais_dependentes: [
        { $sort: { familias_por_100_hab: -1 } },
        { $limit: 15 },
        { $project: { _id: 0, cod_ibge: "$_id", municipio: 1, uf: 1, populacao: 1,
                      parcelas_regulares: 1, familias_por_100_hab: 1,
                      valor_per_capita: 1, pib_per_capita: 1 } }
      ],
      menos_dependentes: [
        { $sort: { familias_por_100_hab: 1 } },
        { $limit: 10 },
        { $project: { _id: 0, cod_ibge: "$_id", municipio: 1, uf: 1, populacao: 1,
                      parcelas_regulares: 1, familias_por_100_hab: 1,
                      valor_per_capita: 1, pib_per_capita: 1 } }
      ],
      por_faixa_de_pib_per_capita: [
        { $match: { pib_per_capita: { $ne: null } } },
        { $bucket: {
            groupBy: "$pib_per_capita",
            boundaries: [0, 15000, 25000, 40000, 70000, 120000, 10000000],
            default: "sem PIB informado",
            output: {
              municipios: { $sum: 1 },
              populacao: { $sum: "$populacao" },
              familias: { $sum: "$parcelas_regulares" },
              total_pago: { $sum: "$total_pago" },
              media_familias_por_100_hab: { $avg: "$familias_por_100_hab" }
            }
        } }
      ],
      resumo: [
        { $group: { _id: null, municipios: { $sum: 1 },
                    familias: { $sum: "$parcelas_regulares" },
                    total_pago: { $sum: "$total_pago" } } }
      ]
  } }
];

mostrarPipeline(pipeline2);
const r2 = executar("pagamentos_bf", pipeline2)[0];

subtitulo("Municipios com a maior proporcao de familias atendidas (>= 20 mil hab.)");
tabela([
  { rotulo: "Municipio", campo: "municipio", largura: 26 },
  { rotulo: "UF", campo: "uf", largura: 3 },
  { rotulo: "Populacao", campo: "populacao", largura: 10, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Familias", campo: "parcelas_regulares", largura: 9, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Fam./100 hab", campo: "familias_por_100_hab", largura: 12, alinha: "d",
    formato: v => numero(v, 2) },
  { rotulo: "Pago/hab", campo: "valor_per_capita", largura: 12, alinha: "d",
    formato: v => reais(v, 2) },
  { rotulo: "PIB/hab (ano)", campo: "pib_per_capita", largura: 14, alinha: "d",
    formato: v => reais(v, 0) }
], r2.mais_dependentes);

subtitulo("Municipios com a menor proporcao de familias atendidas (>= 20 mil hab.)");
tabela([
  { rotulo: "Municipio", campo: "municipio", largura: 26 },
  { rotulo: "UF", campo: "uf", largura: 3 },
  { rotulo: "Populacao", campo: "populacao", largura: 10, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Familias", campo: "parcelas_regulares", largura: 9, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Fam./100 hab", campo: "familias_por_100_hab", largura: 12, alinha: "d",
    formato: v => numero(v, 2) },
  { rotulo: "Pago/hab", campo: "valor_per_capita", largura: 12, alinha: "d",
    formato: v => reais(v, 2) },
  { rotulo: "PIB/hab (ano)", campo: "pib_per_capita", largura: 14, alinha: "d",
    formato: v => reais(v, 0) }
], r2.menos_dependentes);

subtitulo("Faixas de PIB per capita do municipio ($bucket)");
tabela([
  { rotulo: "Faixa de PIB per capita (R$/ano)", campo: "_id", largura: 31,
    formato: function (v, linha) {
      const limites = { 0: "ate 15.000", 15000: "15.000 a 25.000",
                        25000: "25.000 a 40.000", 40000: "40.000 a 70.000",
                        70000: "70.000 a 120.000", 120000: "acima de 120.000" };
      return limites[v] !== undefined ? limites[v] : String(v);
    } },
  { rotulo: "Municipios", campo: "municipios", largura: 10, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Populacao", campo: "populacao", largura: 13, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Familias", campo: "familias", largura: 12, alinha: "d",
    formato: v => numero(v) },
  { rotulo: "Media fam./100 hab", campo: "media_familias_por_100_hab",
    largura: 18, alinha: "d", formato: v => numero(v, 2) }
], r2.por_faixa_de_pib_per_capita);

print("");
print("LEITURA DO RESULTADO: a media de familias por 100 habitantes cai forte e de");
print("forma continua ate a faixa de 70 mil a 120 mil reais de PIB por habitante -");
print("de cerca de 19 para cerca de 5 familias por 100 habitantes. O programa esta,");
print("portanto, concentrado nos municipios de economia mais fraca.");
print("");
print("A ULTIMA FAIXA E UMA EXCECAO IMPORTANTE e sobe de novo. Ela reune apenas 56");
print("municipios e mistura dois tipos muito diferentes: cidades industriais onde a");
print("riqueza chega as familias (Paulinia/SP, com 3,2 familias por 100 habitantes,");
print("e Louveira/SP, com 2,9) e cidades cujo PIB e inflado por refinaria, royalties");
print("de petroleo ou uma unica grande planta, sem que isso vire renda domestica -");
print("Sao Francisco do Conde/BA tem PIB de R$ 642 mil por habitante e 19,2 familias");
print("por 100 habitantes; Sao Joao da Barra/RJ tem R$ 361 mil e 15,1.");
print("Licao metodologica: PIB per capita mede producao no territorio, nao renda das");
print("pessoas. Onde os dois se descolam, o indicador engana - e o dado do programa");
print("revela a pobreza que a media do PIB esconde.");
printjson(r2.resumo[0]);
