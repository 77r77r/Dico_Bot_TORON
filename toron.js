require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { version } = require('discord.js');
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,   // 슬래시 명령어 등록에 필수
        GatewayIntentBits.GuildMessages,    // 메시지 수신
        GatewayIntentBits.MessageContent,   // 메시지 내용 접근
        GatewayIntentBits.GuildMessageReactions, // 서버 내 메시지의 반응 이벤트(이모지 추가/제거 등)를 감지 권한

    ]
});

/**
 * 기본 설정 세팅
 */
const SERVER_ID = process.env.SERVER_ID;
let COMMAND_CHANNEL_ID; // 명령어를 호출할 채널
let KEYWORD_CHANNEL_ID; // !투표 명령어 채널
let TARGET_CHANNEL_ID;  // 투표가 올라갈 채널
let VOTE_TIME;  // 투표 시간 설정
let revote_state = false; // 재투표 진행 여부

const SEPARATOR = '----------------------------\n';

async function main() {
    if (process.env.NODE_ENV === 'production') {
        // 운영환경
        console.log("운영 모드");

        KEYWORD_CHANNEL_ID = process.env.KEYWORD_CHANNEL_ID;
        TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
        COMMAND_CHANNEL_ID = process.env.COMMAND_CHANNEL_ID;
        
        VOTE_TIME = process.env.VOTE_TIME;

    } else {
        // 개발환경
        console.log("개발 모드");
        console.log(`discord.js 버전: ${version}`);

        KEYWORD_CHANNEL_ID = process.env.TEST_COMMAND_CHANNEL_ID;
        TARGET_CHANNEL_ID = process.env.TEST_TARGET_CHANNEL_ID;
        COMMAND_CHANNEL_ID = process.env.TEST_COMMAND_CHANNEL_ID;
        
        VOTE_TIME = process.env.TEST_VOTE_TIME;
    }

    await deleteCommands();
    await createCommands();
}

const COMMAND_LIST = {
    VOTE : '투표',
    REVOTE : '재투표',
    RESULT : '결과',
    TOPIC : '주제',
    TIMER : '타이머',
    TIME : 'second'
};

/** 명령어 목록 */
const commandsList = [
    new SlashCommandBuilder()
        .setName(COMMAND_LIST.VOTE)
        .setDescription('투표를 진행합니다.')
        .addStringOption(option =>
            option.setName(COMMAND_LIST.TOPIC)
            .setDescription('투표 주제를 입력하세요.')
            .setRequired(true)),
    new SlashCommandBuilder()
        .setName(COMMAND_LIST.REVOTE)
        .setDescription('재투표를 진행시 /결과 확인 가능'),
    new SlashCommandBuilder()
        .setName(COMMAND_LIST.RESULT)
        .setDescription('변동값을 확인합니다.'),
    new SlashCommandBuilder()
        .setName(COMMAND_LIST.TIMER)
        .setDescription('초(s)를 입력해주세요.')
        .addStringOption(option =>
            option.setName(COMMAND_LIST.TIME)
            .setDescription('진행 시간(초)을 입력해주세요')
            .setRequired(true)),
].map(commandsList => commandsList.toJSON());

async function createCommands() {
    try {
        console.log('📡 슬래시 명령어 등록 중...');
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.SERVER_ID),
            { body: commandsList }
        );
        console.log('✅ 슬래시 명령어 등록 완료');
  
    } catch (error) {
    console.error('❌ 등록 실패:', error);
  }
    
}

async function deleteCommands() {
    try {
        console.log('⛔ 전체 명령어 삭제 중...');
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.SERVER_ID),
            { body: [] } // 빈 배열로 덮어쓰기
        );
        console.log('✅ 삭제 완료!');
    } catch (error) {
        console.error('삭제 실패:', error);
    }    
}


// 전역에 저장할 변수 (메모리 기반, 서버 재시작 시 W초기화됨)
let lastVoteContent = null;
let savedVoteResult = new Map();


async function isValidChannel(targetChannel) {
    try {
        if (!targetChannel || !targetChannel.isTextBased?.()) {
            console.error('targetChannel 오류:', targetChannel);
            return false;
        }
        return true;
    } catch (error) {
        console.error('채널 확인 중 오류:', error);
        return false;
    }
}

async function voteTimer(targetChannel, time) {
    await targetChannel.send(`${SEPARATOR}⏳ ${time} 초간 진행됩니다!\n${SEPARATOR}`);
    setTimeout(async () => {
        await targetChannel.send(`${SEPARATOR}⏰ 종료되었습니다!\n${SEPARATOR}`);
    }, time * 1000);    
}


/** 
 * 메시지에 이모지 표기하기
 */
async function reactEmoji(sentMessage) {
    const keywordEmoji = [
        '🇦', '🇧', '🇵'
    ];

    const react = keywordEmoji.map((emoji) => sentMessage.react(emoji));
    await Promise.allSettled(react);
}

/**
 * !투표 : 투표 메시지 전송
 * @param {투표 메시지 송신 채널} targetChannel 
 * @param {투표 주제} content 
 */
async function startVote(targetChannel, content) {
    const sentMessage = await targetChannel.send(`${SEPARATOR} [ 투표 ]\n${content}`);
    await reactEmoji(sentMessage);
    await targetChannel.send(`${SEPARATOR}`);

    savedVoteResult.set('vote_msgid', sentMessage.id);
    lastVoteContent = content;
}

/**
 * !재투표 : 기존 주제로 재투표 전송
 * @param {재투표 메시지 송신 채널} targetChannel 
 */
async function restartVote(targetChannel) {
    const sentMessage = await targetChannel.send(`${SEPARATOR} [ 재투표 ]\n${lastVoteContent}`);
    await reactEmoji(sentMessage);
    await targetChannel.send(`${SEPARATOR}`);

    revote_state = true;
    savedVoteResult.set('revote_msgid', sentMessage.id);
}


async function getReactionCounts(targetChannel, messageId) {
    try {
        const message = await targetChannel.messages.fetch(messageId, { force: true });
        const counts = {};

        // await Promise.all(
        //     message.reactions.cache.map(reaction => reaction.users.fetch()) // 사용자 정보를 업데이트
        // );

        await Promise.all (
            message.reactions.cache.map(async (reaction) => {
                const refreshed = await reaction.fetch();
                const emoji = refreshed.emoji.name ?? refreshed.emoji.id;
                counts[emoji] = refreshed.count;
            })
        );
        
        return counts;

    } catch (err) {
        console.error(`메시지 ${messageId}에서 반응 수집 실패`, err);
        return {};
    }
}

async function countVotes(channel) {    
    const pastCount = await getReactionCounts(channel, savedVoteResult.get('vote_msgid'));
    const currCount = await getReactionCounts(channel, savedVoteResult.get('revote_msgid'));

    // 모든 이모지 집합 생성
    const allEmojis = new Set([
        ...Object.keys(pastCount),
        ...Object.keys(currCount)
    ]);

    let voteResultMsg = `${SEPARATOR} [투표 결과 비교]\n ${lastVoteContent}\n`;

    for (const emoji of allEmojis) {
        const before = (pastCount[emoji] || 0) - 1;
        const after = (currCount[emoji] || 0) - 1;
        const diff = after - before;
        const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
        voteResultMsg += `${emoji} :\t${before}\t→\t${after}\t(${arrow} ${Math.abs(diff)})\n`;
    }
    voteResultMsg += SEPARATOR;

    await channel.send(voteResultMsg);

    savedVoteResult.clear();
    lastVoteContent = null;
}

/** 명령어 처리 */
async function checkCommand(targetChannel, commandName, interaction) {
    if (commandName === COMMAND_LIST.VOTE) {
        // 투표
        try {
            const content = interaction.options.getString(COMMAND_LIST.TOPIC);

            await interaction.reply(`투표가 등록 되었습니다.`);
            await startVote(targetChannel, content);

        } catch (err) {
            console.error('투표 명령어 오류:', err);
            await interaction.reply('투표 중 오류가 발생했습니다.');
        }
        
    } else if (commandName === COMMAND_LIST.REVOTE) {
        // 재투표
        if (!lastVoteContent) return interaction.reply('투표를 먼저 진행해주세요.');
    
        try {
            if (revote_state) {
                interaction.reply('이미 재투표가 진행되었습니다.');
                return;
            }

            await interaction.reply(`재투표를 진행합니다.`);
            restartVote(targetChannel);
            
        } catch (err) {
            console.error('재투표 명령어 오류:', err);
            interaction.reply('재투표 중 오류가 발생했습니다.');
        }

    } else if (commandName === COMMAND_LIST.RESULT) {
        // 결과
        if (!revote_state) {
            interaction.reply('재투표를 먼저 진행해주세요.');
            return;
        }

        if (!(savedVoteResult instanceof Map) || savedVoteResult.size <= 0) {
            interaction.reply('저장된 투표 결과가 없습니다.');
            return;
        }

        try {
            await interaction.reply(`결과 표기`);
            await countVotes(targetChannel);

        } catch (err) {
            console.error('결과 명령어 오류:', err);
            interaction.reply('결과 중 오류가 발생했습니다.');
        }
    } else if (commandName === COMMAND_LIST.TIMER) {
        await interaction.reply(`타이머를 시작합니다`);

        try {
            const time = parseInt(interaction.options.getString(COMMAND_LIST.TIME), 10);
            voteTimer(targetChannel, time);
        } catch (err) {
            console.error('타이머 명령어 오류:', err);
            message.reply('타이머 실행 중 오류가 발생했습니다.');
        }     
        
    }
}

client.on('ready', () => {
    console.log(`✅ 로그인됨: ${client.user.tag}`);
});

/** '/' 명령어로 실행하는 경우 */
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // 입력된 명령어 받아오기
    const { commandName } = interaction;

    try {
        const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);

        if (!(await isValidChannel(targetChannel))) return null;

        await checkCommand(targetChannel, commandName, interaction);
        
    } catch (err) {
        console.error(err);
        message.reply('오류가 발생했습니다.');
    }    
});

client.login(process.env.TOKEN);
main();

