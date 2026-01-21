require('dotenv').config();
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const express = require('express');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');

// --- SERVIDOR WEB (Para exibir QR Code e Manter Acordado) ---
const app = express();
const port = process.env.PORT || 3000;

let currentQR = null; // Variável para guardar o QR Code atual
let isConnected = false; // Variável para saber se já conectou

app.get('/', async (req, res) => {
    if (isConnected) {
        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1 style="color: green;">✅ Robô Conectado!</h1>
                <p>O WhatsApp está ativo e monitorando.</p>
            </div>
        `);
    } else if (currentQR) {
        // Gera a imagem do QR Code para exibir no navegador
        const url = await QRCodeImage.toDataURL(currentQR);
        res.send(`
            <html>
                <head>
                    <meta http-equiv="refresh" content="5"> <!-- Atualiza a cada 5s -->
                    <style>body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f2f5; margin: 0; }</style>
                </head>
                <body>
                    <div style="background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); text-align: center;">
                        <h2 style="margin-bottom: 20px; color: #333;">Escaneie para Conectar</h2>
                        <img src="${url}" style="width: 300px; height: 300px;" />
                        <p style="margin-top: 20px; color: #666;">A página atualiza automaticamente.</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>⏳ Iniciando...</h1>
                <p>Aguardando geração do QR Code. A página irá atualizar.</p>
                <script>setTimeout(function(){ location.reload(); }, 3000);</script>
            </div>
        `);
    }
});

app.listen(port, () => {
    console.log(`🌍 Servidor Web rodando na porta ${port}`);
});
// -----------------------------------------------------

console.log('Iniciando Robô de Contratos...');

const { checkEmails } = require('./src/services/email');
const { fetchServerList } = require('./src/services/sheets');
const { extractTextFromPDF, findServerInPDF } = require('./src/services/parser');
const { MessageMedia } = require('whatsapp-web.js');

(async () => {
    let authStrategy;

    // Verifica se tem banco de dados configurado (Modo Nuvem)
    if (process.env.MONGODB_URI) {
        console.log('☁️  Ambiente Cloud detectado (MongoDB). Conectando ao banco...');
        try {
            await mongoose.connect(process.env.MONGODB_URI);
            const store = new MongoStore({ mongoose: mongoose });
            authStrategy = new RemoteAuth({
                store: store,
                backupSyncIntervalMs: 60000
            });
            console.log('✅ Conectado ao MongoDB! Usando RemoteAuth para salvar sessão.');
        } catch (err) {
            console.error('❌ Erro ao conectar no MongoDB:', err);
            console.log('⚠️  Caindo para LocalAuth (sessão não será salva se reiniciar)...');
            authStrategy = new LocalAuth();
        }
    } else {
        console.log('🏠 Ambiente Local detectado. Usando LocalAuth (arquivos locais).');
        authStrategy = new LocalAuth();
    }

    // Inicialização do Cliente WhatsApp
    const client = new Client({
        authStrategy: authStrategy,
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`CARREGANDO WHATSAPP: ${percent}% - ${message}`);
    });

    client.on('authenticated', () => {
        console.log('AUTENTICADO! Carregando chats...');
        isConnected = true;
        currentQR = null; // Limpa QR
    });

    client.on('qr', (qr) => {
        console.log('QR RECEIVED (Disponível na URL do App)');
        currentQR = qr; // Atualiza variável para exibir no site
        isConnected = false;

        // Fallback: Exibe no terminal também (útil para debug local)
        qrcode.generate(qr, { small: true });
    });

    client.on('auth_failure', msg => {
        console.error('FALHA DE AUTENTICAÇÃO', msg);
        isConnected = false;
    });

    client.on('disconnected', (reason) => {
        console.log('Cliente desconectado', reason);
        isConnected = false;
    });

    // Fallback: Tenta capturar o ID do grupo se receber uma mensagem de lá
    // Usamos 'message_create' para detectar também as mensagens enviadas PELA PRÓPRIA conta (do celular do usuário)
    client.on('message_create', async msg => {
        try {
            let chat;
            try {
                chat = await msg.getChat();
            } catch (err) {
                console.log(`[ERRO LEITURA CHAT] Ignorando msg de ${msg.from}. Motivo: ${err.message}`);
                return;
            }

            const chatName = chat.name || ''; // Garante que não quebre se name for undefined
            console.log(`[MSG DETECTADA] De: ${msg.from} | Chat: "${chatName}" | Msg: "${msg.body}"`);

            // TESTE ESPECÍFICO PARA PAULO HERRY
            if (chatName.toLowerCase().includes('paulo herry')) {
                console.log(`[TESTE PAULO] Detectado chat Paulo Herry. ID: ${msg.from}`);
                client.sendMessage(msg.from, '🤖 Olá Paulo! Teste de envio direto do robô.').catch(console.error);
            }

            const targetName = process.env.WHATSAPP_GROUP_NAME || 'Programação';

            // Verifica se é o grupo certo (comparação flexível)
            if (!targetGroupId && chat.isGroup && chatName.toLowerCase().includes(targetName.toLowerCase())) {
                targetGroupId = chat.id._serialized;
                console.log(`✅ GRUPO IDENTIFICADO! ID: ${targetGroupId}`);
                // msg.reply estava dando erro de 'markedUnread', mudando para sendMessage direto
                await client.sendMessage(targetGroupId, '🤖 Robô Conectado! Grupo identificado com sucesso.');
            }

            // Comando de teste manual de envio
            if (msg.body.trim().toLowerCase() === '.ping') {
                console.log('[COMANDO] .ping recebido, tentando responder...');
                const chatId = msg.from; // Ou targetGroupId se preferir forçar no grupo alvo
                await client.sendMessage(chatId, '🏓 Pong! O envio de mensagens está funcionando.');
            }
        } catch (e) {
            console.error('Erro ao processar mensagem recebida:', e);
        }
    });

    let targetGroupId = '5511963952322-1553402776@g.us'; // ID HARDCODED PARA GARANTIR O ENVIO
    const CHECK_INTERVAL = 60000;

    client.on('remote_session_saved', () => {
        console.log('✅ Sessão do WhatsApp salva no MongoDB com sucesso!');
    });

    client.on('ready', async () => {
        console.log('WhatsApp Conectado com Sucesso!');
        isConnected = true;
        currentQR = null;

        // --- CORREÇÃO CRÍTICA (MONKEY PATCH) ---
        // Força o navegador a ignorar a função sendSeen que está quebrada na versão atual do WhatsApp
        try {
            if (client.pupPage) {
                await client.pupPage.evaluate(() => {
                    window.WWebJS.sendSeen = async () => { return true; };
                });
                console.log('[PATCH] Correção de sendSeen aplicada com sucesso no navegador!');
            }
        } catch (e) {
            console.error('[PATCH] Falha ao aplicar correção:', e);
        }
        // ---------------------------------------

        // Tenta obter o chat diretamente pelo ID para garantir que ele existe e é válido
        try {
            console.log(`[INIT] Buscando chat pelo ID: ${targetGroupId}`);
            const chat = await client.getChatById(targetGroupId);

            console.log(`[INIT] Chat encontrado: "${chat.name}". Enviando mensagem de teste...`);
            // Usar chat.sendMessage é mais seguro que client.sendMessage
            await chat.sendMessage('✅ Robô Ativo e Atualizado! (Versão Cloud com QR Web)');
            console.log('[INIT] Mensagem enviada com sucesso!');

        } catch (err) {
            console.error('[ERRO INIT] Falha ao buscar chat ou enviar msg:', err);
        }

        // Verificação inicial da planilha
        console.log('Verificando conexão com a planilha...');
        const testList = await fetchServerList();
        if (testList.length > 0) {
            console.log(`✅ SUCESSO: Planilha acessível! ${testList.length} servidores carregados.`);
        } else {
            console.error('❌ ERRO: Não foi possível ler a planilha ou ela está vazia.');
            console.error('Link atual:', process.env.CSV_URL);
        }

        // Tenta encontrar o grupo em background, sem bloquear o email
        findTargetGroup().then(() => {
            if (!targetGroupId) console.log('⚠️ AVISO: Grupo não encontrado inicialmente. O robô tentará buscar novamente antes de enviar mensagens.');
        });

        // Inicia o monitoramento de e-mails IMEDIATAMENTE
        startEmailMonitoring();
    });

    async function findTargetGroup() {
        if (targetGroupId) return; // Já tem

        let chats = [];
        try {
            console.log('Buscando chats no WhatsApp (Timeout: 30s)...');
            // Adiciona timeout para não travar se o WhatsApp demorar para sincronizar
            chats = await Promise.race([
                client.getChats(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ao buscar chats')), 30000))
            ]);
        } catch (err) {
            console.error('Erro detalhado ao buscar chats:', err.message);
            return; // Sai silenciosamente, tentará de novo se precisar enviar msg
        }

        const groupName = process.env.WHATSAPP_GROUP_NAME || 'Programação'; // Fallback

        // Debug: Listar todos os grupos processados para auditoria
        console.log('--- LISTA DE GRUPOS ENCONTRADOS ---');
        chats.filter(c => c.isGroup).forEach(c => console.log(`[GRUPO] Nome: "${c.name}" | ID: ${c.id._serialized} | isGroup: ${c.isGroup}`));
        console.log('-----------------------------------');

        const group = chats.find(chat => chat.isGroup && chat.name.toLowerCase() === groupName.toLowerCase());

        if (group) {
            targetGroupId = group.id._serialized;
            console.log(`✅ GRUPO ENCONTRADO! Nome: "${group.name}" | ID: ${targetGroupId}`);
        } else {
            console.log(`❌ Grupo "${groupName}" NÃO encontrado na lista acima.`);
        }
    }

    async function startEmailMonitoring() {
        console.log('Iniciando ciclo de monitoramento...');

        // Função que processa cada PDF encontrado
        const onContractFound = async (pdfBuffer, subject, emailItem) => {
            try {
                // 1. Baixa a lista atualizada
                const serverList = await fetchServerList();

                // 2. Lê o PDF
                const pdfText = await extractTextFromPDF(pdfBuffer);

                // 3. Procura o servidor (Busca no Texto do PDF + Assunto do E-mail)
                // Concatena assunto e texto para aumentar a chance de match (ex: contrato no assunto)
                const combinedText = `${subject} ${pdfText}`.toUpperCase();
                const match = findServerInPDF(combinedText, serverList);

                if (match) {
                    console.log(`MATCH! Contrato pertence a: ${match.name}`);
                    console.log('--- [DEBUG DADOS DA LINHA ENCONTRADA] ---');
                    console.log(JSON.stringify(match, null, 2)); // Mostra TODAS as colunas e valores exatos
                    console.log('-------------------------------------------');

                    // Garante que temos o ID do grupo antes de enviar
                    if (!targetGroupId) {
                        console.log('Tentando localizar ID do grupo antes do envio...');
                        await findTargetGroup();
                    }

                    if (targetGroupId) {
                        // 4. Envia mensagem no grupo
                        const media = new MessageMedia('application/pdf', pdfBuffer.toString('base64'), 'Contrato.pdf');

                        // Helper para buscar valor ignorando espaços e maiúsculas/minúsculas nas chaves
                        const getValue = (targetKey) => {
                            // O objeto retornado pelo parser tem os dados brutos dentro de .data
                            const dadosReais = match.data || match;

                            console.log(`[DEBUG BUSCA] Procurando por chave: "${targetKey}"`);
                            const keys = Object.keys(dadosReais);

                            const keyFound = keys.find(k => {
                                const matchResult = k.trim().toUpperCase() === targetKey.trim().toUpperCase();
                                return matchResult;
                            });

                            if (keyFound) {
                                console.log(`   ✅ ENCONTRADO! Chave original: "${keyFound}" | Valor: "${dadosReais[keyFound]}"`);
                                return dadosReais[keyFound];
                            } else {
                                console.log(`   ❌ NÃO ENCONTRADO na lista de chaves disponíveis.`);
                                return null;
                            }
                        };

                        // Busca os valores usando a função blindada
                        // match.name vem do parser, mas queremos o nome real da planilha se possível
                        const empresaNome = getValue('EMPRESA') || match.name || 'Desconhecido';
                        const fiscalNome = getValue('FISCAL DO CONTRATO') || 'Não informado';

                        const objSucinto = getValue('OBJETO SUCINTO');
                        const objCompleto = getValue('OBJETO');
                        const objetoFinal = (objSucinto && objSucinto.trim() !== '') ? objSucinto : (objCompleto || 'Não especificado');

                        const vigenciaInicio = getValue('INÍCIO VIGÊNCIA') || getValue('VIGÊNCIA INICIAL') || getValue('VIGÊNCIA INICIAL (DATA DA ASSINATURA)') || '-';
                        const vigenciaFim = getValue('FIM DA VIGÊNCIA') || getValue('VIGÊNCIA FINAL') || '-';

                        // Tenta várias opções de valor
                        const valor = getValue('VALOR ATUALIZADO') || getValue('VALOR ATUALIZADO R$') || getValue('VALOR') || '-';

                        const caption = `📄 *Novo Contrato Identificado*\n\n` +
                            `🏢 *Empresa:* ${empresaNome}\n` +
                            `👤 *Fiscal do Contrato:* ${fiscalNome}\n` +
                            `📝 *Objeto:* ${objetoFinal}\n` +
                            `📅 *Vigência:* ${vigenciaInicio} a ${vigenciaFim}\n` +
                            `💰 *Valor Atual:* ${valor}\n\n` +
                            `📧 *E-mail:* ${subject}\n` +
                            `_O documento foi encaminhado automaticamente._`;

                        // Usar chat.sendMessage é mais seguro que client.sendMessage
                        try {
                            const chat = await client.getChatById(targetGroupId);
                            await chat.sendMessage(media, { caption: caption });
                            console.log('Mensagem enviada para o grupo.');
                        } catch (sendErr) {
                            console.error('Erro ao enviar mensagem:', sendErr);
                        }
                    } else {
                        console.error('❌ ERRO CRÍTICO: Impossível enviar mensagem. Grupo não identificado.');
                    }
                } else {
                    console.log('PDF lido, mas nenhum servidor da lista foi identificado no conteúdo.');
                }

            } catch (err) {
                console.error('Erro ao processar contrato:', err);
            }
        };

        // Loop infinito (com delay)
        const runCycle = async () => {
            await checkEmails(onContractFound);
            console.log(`Aguardando ${CHECK_INTERVAL / 1000} segundos...`);
            setTimeout(runCycle, CHECK_INTERVAL);
        };

        runCycle();
    }

    console.log('Inicializando cliente WhatsApp...');
    client.initialize().catch(err => {
        console.error('ERRO FATAL AO INICIAR:', err);
    });

})();

