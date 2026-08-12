# Guia de Compilação do OpenMausBot no Windows

Para gerar o instalador nativo (`.exe`) no seu computador, siga os passos abaixo. Este processo utiliza o **Electron Builder** que já deixei configurado no repositório.

---

## 1. Pré-requisitos

Certifique-se de ter as seguintes ferramentas instaladas no seu Windows:

*   **Node.js (Versão LTS):** Baixe em [nodejs.org](https://nodejs.org/).
*   **Git:** Baixe em [git-scm.com](https://git-scm.com/).

---

## 2. Passo a Passo para Gerar o .exe

Abra o seu terminal (PowerShell ou Prompt de Comando) e execute a seguinte sequência de comandos:

### Passo 1: Clonar o seu novo repositório
```powershell
git clone https://github.com/acruz6421-bot/OpenMausBotWindows.git
cd OpenMausBotWindows
```

### Passo 2: Instalar as dependências do projeto
Este comando baixará todas as bibliotecas necessárias, incluindo o Electron e o Vite.
```powershell
npm install
```

### Passo 3: Compilar e Gerar o Instalador
Execute o script de empacotamento que criei especificamente para Windows:
```powershell
npm run package:win
```

---

## 3. Onde encontrar o instalador?

Após o término do comando acima, uma pasta chamada **`release`** será criada na raiz do projeto. Dentro dela, você encontrará:

*   **`OpenMausBot-0.1.3-x64-setup.exe`**: O instalador executável para Windows.
*   **`win-unpacked/`**: Uma versão do aplicativo que pode ser executada sem instalação.

---

## Dicas Adicionais

*   **Reconhecimento de Voz:** O ditado por voz funcionará automaticamente no Windows 10/11 usando o componente PowerShell que implementei.
*   **Erros de Permissão:** Se o comando `npm install` falhar, tente abrir o terminal como **Administrador**.
*   **Desenvolvimento:** Se quiser apenas testar o app sem gerar o instalador, use o comando `npx electron .` após o `npm install`.
