// Preload dedicado da Tela do Cliente — isolado do preload.js principal de
// propósito: essa janela é só uma vitrine, não precisa de nenhuma das
// chamadas IPC do PDV, só ouvir os dois eventos que o main manda.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('telaCliente', {
  onProduto: (cb) => ipcRenderer.on('cliente:produto', (_, data) => cb(data)),
  // data: { produtos, intervaloSeg, tag } — produtos com a tag de destaque,
  // pro carrossel enquanto ociosa. produtos vazio = só mostra a logo.
  onIdle: (cb) => ipcRenderer.on('cliente:idle', (_, data) => cb(data)),
});
