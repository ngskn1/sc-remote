// Interface language for the remote-desktop windows: English, or Portuguese (Brazil).
// t('English text', ...args) gives the text in the current language; {0}, {1}… are filled with args.
// Messages from the other PC arrive in English and are translated here too (exactly, by pattern, or by prefix).
'use strict';
(function () {
  const PT = {
    // manager (remote.html)
    'Remote desktop': 'Área de trabalho remota',
    'This computer': 'Este computador',
    'Allow remote control of this PC': 'Permitir o controle remoto deste PC',
    'Copy': 'Copiar',
    'New ID': 'Novo ID',
    'Make a new ID (computers saved with the old one stop working)': 'Criar um novo ID (computadores salvos com o antigo deixam de funcionar)',
    'Off': 'Desligado',
    'Password': 'Senha',
    'at least 6 characters': 'pelo menos 6 caracteres',
    'Set password': 'Definir senha',
    'Start with the computer (in the background)': 'Iniciar com o computador (em segundo plano)',
    'Keep this PC awake while remote access is on': 'Manter este PC acordado enquanto o acesso remoto estiver ligado',
    'Change password or settings…': 'Alterar senha ou configurações…',
    'Set up remote access…': 'Configurar o acesso remoto…',
    'Windows asks for administrator permission.': 'O Windows pede permissão de administrador.',
    'Connect to a PC': 'Conectar a um PC',
    'Name (optional)': 'Nome (opcional)',
    'e.g. Home PC': 'ex.: PC de casa',
    'Remember this PC (password stored encrypted on this computer)': 'Lembrar este PC (senha guardada criptografada neste computador)',
    'Connect': 'Conectar',
    'Forget': 'Esquecer',
    'A password is set. Setting a new one disconnects anyone connected.': 'Há uma senha definida. Definir uma nova desconecta quem estiver conectado.',
    'No password yet: set one to turn remote access on.': 'Ainda sem senha: defina uma para ligar o acesso remoto.',
    'Connecting to the internet…': 'Conectando à internet…',
    'Online, waiting for connections': 'Online, aguardando conexões',
    'Being controlled from {0}': 'Sendo controlado a partir de {0}',
    'another PC': 'outro PC',
    'Problem: {0}': 'Problema: {0}',
    'offline': 'offline',
    'Starting…': 'Iniciando…',
    'Remote access to this PC is off': 'O acesso remoto a este PC está desligado',
    'Others connect with this ID and the password set for this PC. It works from startup, also at the sign-in screen, as long as the PC is on and online.':
      'Os outros se conectam com este ID e a senha definida para este PC. Funciona desde a inicialização, também na tela de entrada, desde que o PC esteja ligado e online.',
    'Others can\'t connect to this PC. You can still connect to other PCs below.': 'Ninguém consegue se conectar a este PC. Você ainda pode se conectar a outros PCs abaixo.',
    'Remote access is on.': 'Acesso remoto ligado.',
    'Remote access is off.': 'Acesso remoto desligado.',
    'Password saved.': 'Senha salva.',
    '{0} will start with the computer.': '{0} vai iniciar com o computador.',
    'Won\'t start with the computer.': 'Não vai iniciar com o computador.',
    'ID copied.': 'ID copiado.',
    'New ID created.': 'Novo ID criado.',
    'Opening a window for {0}…': 'Abrindo uma janela para {0}…',
    ' It is saved once the password works.': ' Ele será salvo quando a senha funcionar.',
    'Opening the settings…': 'Abrindo as configurações…',
    'Saved. Changes apply within a few seconds.': 'Salvo. As mudanças valem em alguns segundos.',
    'Report a problem or send feedback': 'Relatar um problema ou enviar sugestões',
    'Language': 'Idioma',
    'The ID has 9 digits': 'O ID tem 9 dígitos',
    'Enter the password': 'Digite a senha',
    'Use at least 6 characters': 'Use pelo menos 6 caracteres',
    'Set a password first': 'Defina uma senha primeiro',
    'Could not open the settings (they need administrator permission)': 'Não foi possível abrir as configurações (é preciso permissão de administrador)',
    'The remote access service is not installed': 'O serviço de acesso remoto não está instalado',
    'With remote access on, ScreenShare keeps running in the tray after you close its windows. Anyone with the ID and password can control this PC.':
      'Com o acesso remoto ligado, o ScreenShare continua rodando na bandeja depois que você fecha as janelas. Qualquer pessoa com o ID e a senha pode controlar este PC.',

    // session window (remote-session.html)
    'Which screen to show': 'Qual tela mostrar',
    'Sharp keeps text crisp; Smooth keeps motion fluid on slow connections': 'Nítido mantém o texto legível; Fluido mantém o movimento suave em conexões lentas',
    'Sharp text': 'Texto nítido',
    'Smooth': 'Fluido',
    'Frames per second': 'Quadros por segundo',
    'Video codec': 'Codec de vídeo',
    'Copy on one computer, paste on the other (text and images)': 'Copie em um computador e cole no outro (texto e imagens)',
    'Clipboard': 'Área de transferência',
    'Browse the remote PC\'s files, download, upload (or drop files on this window)': 'Ver os arquivos do PC remoto, baixar, enviar (ou soltar arquivos nesta janela)',
    'Files': 'Arquivos',
    'Send keys this computer would otherwise catch': 'Enviar teclas que este computador capturaria',
    'Keys ▾': 'Teclas ▾',
    'Windows / Super key': 'Tecla Windows / Super',
    'Ctrl + Alt + L (lock)': 'Ctrl + Alt + L (bloquear)',
    'Fullscreen (in fullscreen, Alt+Tab and the Windows key go to the remote PC; hold Esc to leave)': 'Tela cheia (em tela cheia, Alt+Tab e a tecla Windows vão para o PC remoto; segure Esc para sair)',
    'Fullscreen': 'Tela cheia',
    'Exit fullscreen': 'Sair da tela cheia',
    'Keep this toolbar visible': 'Manter esta barra visível',
    'Pin': 'Fixar',
    'Disconnect': 'Desconectar',
    'Connecting…': 'Conectando…',
    'Connect again': 'Conectar de novo',
    'Close': 'Fechar',
    'Trust the new identity': 'Confiar na nova identidade',
    'Files on': 'Arquivos em',
    'Upload…': 'Enviar…',
    'Up one folder': 'Subir uma pasta',
    'Home folder': 'Pasta pessoal',
    'Release where you want the files on the remote PC': 'Solte onde você quer os arquivos no PC remoto',
    'Connection log of this PC': 'Registro de conexões deste PC',
    'When': 'Quando', 'What': 'O quê', 'Who': 'Quem',
    'Log': 'Registro',
    'Signing in…': 'Entrando…',
    'Sign-in failed: ': 'Falha ao entrar: ',
    'Starting video…': 'Iniciando o vídeo…',
    'Access denied': 'Acesso negado',
    'Disconnected': 'Desconectado',
    'Back on the desktop': 'De volta à área de trabalho',
    'Showing the sign-in / lock / administrator prompt screen': 'Mostrando a tela de entrada / bloqueio / permissão de administrador',
    'The connection stopped responding.': 'A conexão parou de responder.',
    'Connection lost.': 'Conexão perdida.',
    '{0} Reconnecting in {1} s…': '{0} Reconectando em {1} s…',
    'Connection problem ({0}).': 'Problema de conexão ({0}).',
    '{0} is offline (PC off or asleep, or ScreenShare not running).': '{0} está offline (PC desligado ou em suspensão, ou o programa não está rodando).',
    'Switching codec…': 'Trocando o codec…',
    'Turned off for this lab': 'Desativado neste laboratório',
    'Open folder': 'Abrir pasta',
    'Download to this PC': 'Baixar para este PC',
    'Empty folder': 'Pasta vazia',
    'Could not open folder: ': 'Não foi possível abrir a pasta: ',
    'Cancel': 'Cancelar',
    'Cancelled': 'Cancelado',
    'Show': 'Mostrar',
    'Downloaded to ': 'Baixado em ',
    'Failed: ': 'Falhou: ',
    'Copy cancelled': 'Cópia cancelada',
    'Copy failed: ': 'Falha na cópia: ',
    'Upload cancelled': 'Envio cancelado',
    'Upload failed: ': 'Falha no envio: ',
    'Could not read the copied files: ': 'Não foi possível ler os arquivos copiados: ',
    'Could not read: ': 'Não foi possível ler: ',
    'Not connected': 'Não conectado',
    'Drop files or folders from this PC.': 'Solte arquivos ou pastas deste PC.',
    'Nothing to connect to.': 'Nada para conectar.',
    'the remote PC': 'o PC remoto',
    '{0} items': '{0} itens',
    'The copied files are {0}, too big to send through the clipboard. Use Files ▸ Upload.': 'Os arquivos copiados têm {0}, grandes demais para a área de transferência. Use Arquivos ▸ Enviar.',
    'Files copied on {0} are {1}, too big for the clipboard. Use the Files panel.': 'Os arquivos copiados em {0} têm {1}, grandes demais para a área de transferência. Use o painel Arquivos.',
    '📋 Copying {0} to {1}…': '📋 Copiando {0} para {1}…',
    '📋 Ready: press Ctrl+V on {0} to paste {1}': '📋 Pronto: pressione Ctrl+V em {0} para colar {1}',
    '📋 Getting {0} from {1}…': '📋 Trazendo {0} de {1}…',
    '📋 Ready: press Ctrl+V here to paste {0}': '📋 Pronto: pressione Ctrl+V aqui para colar {0}',
    '⬆ Uploading {0}…': '⬆ Enviando {0}…',
    '⬆ Uploaded {0} to {1}': '⬆ {0} enviado para {1}',
    '⬆ Sending {0} to {1}…': '⬆ Enviando {0} para {1}…',
    'Dropping {0} on {1}…': 'Soltando {0} em {1}…',
    'Dropped {0} item(s) on {1}. If they didn\'t land where you wanted, press Ctrl+V there.': '{0} item(ns) solto(s) em {1}. Se não caíram onde você queria, pressione Ctrl+V lá.',
    'Couldn\'t drop there ({0}). They\'re on {1}\'s clipboard: press Ctrl+V there.': 'Não foi possível soltar ali ({0}). Eles estão na área de transferência de {1}: pressione Ctrl+V lá.',

    // messages from the other PC
    'Wrong password': 'Senha errada',
    'Bad request': 'Pedido inválido',
    'This PC needs a newer ScreenShare app to connect to it (ScreenShare 2.3 or SC-Remote).': 'Este PC precisa de uma versão mais nova do aplicativo para a conexão (ScreenShare 2.3 ou SC-Remote).',
    'The person at that PC declined the connection.': 'A pessoa naquele PC recusou a conexão.',
    'The person at that PC ended the session': 'A pessoa naquele PC encerrou a sessão',
    'Disconnected by the person at that PC': 'Desconectado pela pessoa naquele PC',
    'Another computer took over': 'Outro computador assumiu o controle',
    'Remote access was turned off on that PC': 'O acesso remoto foi desligado naquele PC',
    'Remote access to that PC was turned off': 'O acesso remoto àquele PC foi desligado',
    'The password of that PC was changed': 'A senha daquele PC foi alterada',
    'That PC got a new ID': 'Aquele PC recebeu um novo ID',
    'not allowed': 'não permitido',
    'nothing to drop': 'nada para soltar',
    'could not start the drag on that PC': 'não foi possível começar a arrastar naquele PC',
    'On this PC, files can only be used in the signed-in user\'s folder': 'Neste PC, só é possível usar arquivos da pasta do usuário conectado',
    'That is a folder': 'Isso é uma pasta',

    // on-screen bar and question on the controlled PC (lab-prompt.html)
    'is controlling this PC': 'está controlando este PC',
    'End': 'Encerrar',
    'Disconnect them now': 'Desconectar agora',
    'wants to control this PC (mouse, keyboard and screen).': 'quer controlar este PC (mouse, teclado e tela).',
    'from': 'de',
    'Decline': 'Recusar',
    'Allow': 'Permitir',
    'Declines by itself in {0} s': 'Recusa automática em {0} s',
    '{0} is controlling this PC': '{0} está controlando este PC',
    '{0} is connected with {1}': '{0} está conectado pelo {1}',
    // updates
    'A new version of {0} is available: {1}.': 'Uma nova versão do {0} está disponível: {1}.',
    'Restart and update': 'Reiniciar e atualizar',
    'Downloading version {0}…': 'Baixando a versão {0}…',
    'Installing version {0}… {1} closes and reopens by itself.': 'Instalando a versão {0}… O {1} fecha e abre de novo sozinho.',
    'The update failed: {0}': 'A atualização falhou: {0}',
    'Try again': 'Tentar de novo',
    '{0} was updated to version {1}.': 'O {0} foi atualizado para a versão {1}.',
    'Version {0}': 'Versão {0}',
    'unknown error': 'erro desconhecido',
    'the remote access service is not running': 'o serviço de acesso remoto não está em execução',
    'could not reach the remote access service': 'não foi possível falar com o serviço de acesso remoto',
    'the remote access service did not respond': 'o serviço de acesso remoto não respondeu',
    'the update is taking too long': 'a atualização está demorando demais',
    'could not download the update': 'não foi possível baixar a atualização',
    'could not start the installer': 'não foi possível iniciar o instalador',
    'the update is not signed with the release key': 'a atualização não tem a assinatura oficial do SC-Remote',
    'the update is for another program': 'a atualização é de outro programa',
    'incomplete update manifest': 'os dados da atualização estão incompletos',
    'not an update manifest': 'os dados da atualização são inválidos',
    'no newer version': 'não há uma versão mais nova',
    "the update's address is not allowed": 'o endereço da atualização não é permitido',
    'the downloaded update is damaged': 'o arquivo baixado está corrompido',
    'the installer did not finish': 'o instalador não terminou',
  };
  // messages with numbers in them
  const PATTERNS = [
    [/^Too many wrong passwords\. Try again in (\d+) s\.$/, 'Muitas senhas erradas. Tente de novo em $1 s.'],
    [/^could not download the update \((.+)\)$/, 'não foi possível baixar a atualização ($1)'],
    [/^the installer did not finish \(code (-?\d+)\)$/, 'o instalador não terminou (código $1)'],
  ];
  // "Some message: details from the system" → translate the first part
  const PREFIXES = ['Could not capture the screen: ', 'Could not put the files on the clipboard there: ', 'Could not switch screen: ',
                    'Could not read the copied files: ', 'Mouse/keyboard control is unavailable: ', 'Sign-in failed: '];
  const PT_PREFIX = {
    'Could not capture the screen: ': 'Não foi possível capturar a tela: ',
    'Could not put the files on the clipboard there: ': 'Não foi possível colocar os arquivos na área de transferência de lá: ',
    'Could not switch screen: ': 'Não foi possível trocar de tela: ',
    'Mouse/keyboard control is unavailable: ': 'O controle de mouse/teclado não está disponível: ',
  };
  let lang = 'en';
  function t(s, ...args) {
    if (s == null) return s;
    let r = String(s);
    if (lang === 'pt') {
      if (PT[r] != null) r = PT[r];
      else {
        let done = false;
        for (const [re, rep] of PATTERNS) if (re.test(r)) { r = r.replace(re, rep); done = true; break; }
        if (!done) for (const p of PREFIXES) if (r.startsWith(p)) { r = (PT_PREFIX[p] || PT[p] || p) + r.slice(p.length); break; }
      }
    }
    return args.length ? r.replace(/\{(\d)\}/g, (_, i) => (args[i] != null ? args[i] : '')) : r;
  }
  // translate the page's fixed texts (text, placeholders, tooltips) in place
  function translatePage(root = document.body) {
    if (lang === 'en') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const raw = n.nodeValue, key = raw.trim();
      if (key && PT[key] != null) n.nodeValue = raw.replace(key, PT[key]);
    }
    for (const el of root.querySelectorAll('[title],[placeholder]')) {
      for (const a of ['title', 'placeholder']) { const v = el.getAttribute(a); if (v && PT[v] != null) el.setAttribute(a, PT[v]); }
    }
    if (PT[document.title] != null) document.title = PT[document.title];
  }
  window.I18N = {
    t, translatePage,
    get lang() { return lang; },
    setLang(l) { lang = l === 'pt' ? 'pt' : 'en'; document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en'; },
  };
  window.t = t;
})();
