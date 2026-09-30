/* Funcoes de apresentacao usadas pelos scripts de consulta no mongosh.
   Carregue com:  load("consultas/util_saida.js")                        */

/* eslint-disable no-unused-vars */
const LARGURA = 100;

function titulo(texto) {
  print("");
  print("=".repeat(LARGURA));
  print(" " + texto);
  print("=".repeat(LARGURA));
}

function subtitulo(texto) {
  print("");
  print("-- " + texto + " " + "-".repeat(Math.max(0, LARGURA - texto.length - 4)));
}

function objetivo(texto) {
  print("");
  print("OBJETIVO: " + texto);
}

/** Imprime o pipeline enviado ao servidor, para constar no relatorio. */
function mostrarPipeline(pipeline) {
  print("");
  print("PIPELINE:");
  print(JSON.stringify(pipeline, null, 2).split("\n").map(l => "  " + l).join("\n"));
}

function numero(valor, decimais) {
  if (valor === null || valor === undefined) return "-";
  decimais = decimais === undefined ? 0 : decimais;
  const partes = Number(valor).toFixed(decimais).split(".");
  partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return partes.join(",");
}

function reais(valor, decimais) {
  return valor === null || valor === undefined
    ? "-" : "R$ " + numero(valor, decimais === undefined ? 2 : decimais);
}

/**
 * Tabela de largura fixa.
 * colunas: [{ rotulo, campo, largura, alinha: "e"|"d", formato: fn }]
 */
function tabela(colunas, linhas) {
  const sep = colunas.map(c => "-".repeat(c.largura)).join("  ");
  const cabecalho = colunas.map(function (c) {
    return c.alinha === "d" ? c.rotulo.padStart(c.largura) : c.rotulo.padEnd(c.largura);
  }).join("  ");
  print("");
  print(cabecalho);
  print(sep);
  linhas.forEach(function (linha) {
    print(colunas.map(function (c) {
      let valor = c.campo.split(".").reduce((o, k) => (o === null || o === undefined ? o : o[k]), linha);
      valor = c.formato ? c.formato(valor, linha) : (valor === null || valor === undefined ? "-" : String(valor));
      valor = String(valor);
      if (valor.length > c.largura) valor = valor.slice(0, c.largura - 1) + ".";
      return c.alinha === "d" ? valor.padStart(c.largura) : valor.padEnd(c.largura);
    }).join("  "));
  });
  print(sep);
  print(linhas.length + " linha(s)");
}

/** Executa a agregacao medindo o tempo de parede. */
function executar(colecao, pipeline, opcoes) {
  const inicio = Date.now();
  const resultado = db.getCollection(colecao)
                      .aggregate(pipeline, opcoes || { allowDiskUse: true })
                      .toArray();
  const segundos = (Date.now() - inicio) / 1000;
  print("");
  print("Tempo de execucao: " + segundos.toFixed(2) + " s  |  documentos retornados: " +
        resultado.length);
  return resultado;
}
