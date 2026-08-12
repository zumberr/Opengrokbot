# Guia de Adaptação do OpenMausBot para Windows

O **OpenMausBot** [1] é um assistente de automação desktop integrado com Electron, React, Tailwind CSS e ferramentas de Computer Use (CUA). Originalmente, o projeto dependia fortemente de APIs exclusivas do macOS (como frameworks Swift para ditado por voz e permissões TCC do macOS). 

Este documento detalha o processo de clonagem, análise, adaptação e as instruções completas para compilar e executar o OpenMausBot como um aplicativo nativo para **Windows (Windows 10/11)**.

---

## 1. Análise de Dependências e Barreiras do macOS

Durante a inspeção inicial do repositório original [1], identificamos os seguintes componentes específicos do macOS:
- **Ditado por Voz / Speech Recognition**: Utilizava um script Swift (`electron/resources/speech-helper.swift`) baseado no `SFSpeechRecognizer` da Apple e AVFoundation.
- **Gerenciamento de Permissões (TCC)**: O script `perm-helper.swift` utilizava chamadas privadas do macOS (`CGRequestScreenCaptureAccess`) e caminhos em `~/Library/Application Support`.
- **Configuração de Janela**: Estilo de barra de título com botões de tráfego (`trafficLightPosition`, `hiddenInset`) exclusivos do macOS.
- **Caminhos de Armazenamento**: O servidor de suporte lia conexões de `~/Library/Application Support/OpenMausBot/cua-connection.json`.

---

## 2. Adaptações Realizadas para o Windows

Para tornar o OpenMausBot totalmente cross-platform e nativo no Windows, implementamos as seguintes melhorias:

| Componente | Abordagem no macOS | Nova Implementação Cross-Platform / Windows |
| :--- | :--- | :--- |
| **Reconhecimento de Voz** | `speech-helper.swift` (Swift / Apple Speech) | `speech-helper.ps1` (PowerShell nativo utilizando `.NET System.Speech.Recognition`), integrado dinamicamente no processo principal do Electron. |
| **Armazenamento de Configuração** | `~/Library/Application Support/OpenMausBot` | Suporte duplo a `~/Library/Application Support` (macOS/Linux) e `%APPDATA%\OpenMausBot` (Windows). |
| **Janela e Barra de Título** | `titleBarStyle: "hiddenInset"` com ícones Mac | Ajuste condicional (`process.platform === "darwin"`), utilizando estilo limpo sem bordas no Windows. |
| **Empacotamento (Electron Builder)** | Apenas alvos macOS (`.dmg`, `.zip`) | Configuração completa para Windows (`nsis` para instalador `.exe` e `.zip`), incluindo geração automática de ícone (`icon.ico`). |
| **Gerenciamento de Permissões** | Chamadas TCC da Apple (`CGRequestScreenCaptureAccess`) | Validação condicional e redirecionamento para o painel de configurações de privacidade do Windows (`ms-settings:privacy`). |

---

## 3. Instruções de Instalação e Execução no Windows

Siga os passos abaixo para clonar, configurar e compilar o OpenMausBot em um ambiente Windows:

### Pré-requisitos
- **Node.js** (versão 20 ou superior recomendada)
- **npm** ou **pnpm**

### Passo a Passo

1. **Clonar o Repositório:**
   ```bash
   git clone https://github.com/milind-soni/OpenMausBot.git
   cd OpenMausBot
   ```

2. **Instalar Dependências:**
   ```bash
   npm install
   ```

3. **Executar em Modo de Desenvolvimento (Desktop):**
   Para iniciar o servidor de desenvolvimento Vite em conjunto com o Electron:
   ```bash
   npm run dev
   # Em outro terminal, para iniciar a interface de desktop:
   npx electron .
   ```

4. **Gerar o Instalador Nativo para Windows (.exe):**
   Para compilar o aplicativo completo e gerar o instalador `.exe` (via NSIS) na pasta `release/`:
   ```bash
   npm run package:win
   ```

---

## Referências
- [1] Repositório Oficial do OpenMausBot: [https://github.com/milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot)
