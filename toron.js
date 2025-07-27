require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { version } = require('discord.js');
console.log(`discord.js 버전: ${version}`);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

/**
 * 기본 설정 세팅
 */
const SERVER_ID = process.env.SERVER_ID;
let COMMAND_CHANNEL_ID; // 명령어를 호출할 채널
let KEYWORD_CHANNEL_ID; // !투표 명령어 채널
let TARGET_CHANNEL_ID;  // 투표가 올라갈 채널

// 투표 및 토론 시간 설정
let VOTE_TIME;
let TORON_TIME;

const SEPARATOR = '----------------------------\n';

if (process.env.NODE_ENV === 'production') {
    // 운영환경
    console.log("운영 모드");

    KEYWORD_CHANNEL_ID = process.env.KEYWORD_CHANNEL_ID;
    TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
    COMMAND_CHANNEL_ID = process.env.COMMAND_CHANNEL_ID;
    
    VOTE_TIME = process.env.VOTE_TIME;
    TORON_TIME = process.env.TORON_TIME;

} else {
    // 개발환경
    console.log("개발 모드");

    KEYWORD_CHANNEL_ID = process.env.TEST_COMMAND_CHANNEL_ID;
    TARGET_CHANNEL_ID = process.env.TEST_TARGET_CHANNEL_ID;
    COMMAND_CHANNEL_ID = process.env.TEST_COMMAND_CHANNEL_ID;
    
    VOTE_TIME = process.env.TEST_VOTE_TIME;
    TORON_TIME = process.env.TEST_TORON_TIME;
}


// 전역에 저장할 변수 (메모리 기반, 서버 재시작 시 초기화됨)
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

async function vote30sTimer(targetChannel) {
    await targetChannel.send('----------------------------\n ⏳ 30초간 진행됩니다!\n----------------------------\n');
    setTimeout(async () => {
        await targetChannel.send('----------------------------\n ⏰ 종료되었습니다!\n----------------------------\n');
    }, VOTE_TIME * 1000);
}

async function voteTimer(targetChannel, message, time) {
    try {
        await targetChannel.send(`----------------------------\n ⏳ ${time} 초간 진행됩니다!\n----------------------------\n`);

        setTimeout(async () => {
            await targetChannel.send('----------------------------\n ⏰ 종료되었습니다!\n----------------------------\n');
        }, time * 1000);
    } catch (err) {
        console.error('time30s 명령어 오류:', err);
        message.reply('타이머 실행 중 오류가 발생했습니다.');
    }
}


async function createTextChannel(client, channelName) {
    const guild = client.guilds.cache.get(SERVER_ID);
    await guild.channels.fetch(); 

    try {

        const existingChannel13 = guild.channels.cache.find(ch => ch.name === channelName && ch.type === 0); // type 0 = 텍스트 채널 (v13 이하)
        const existingChannel14 = guild.channels.cache.find(ch => ch.name === channelName && ch.type === 'GUILD_TEXT');

        if (existingChannel13 || existingChannel14) {
            console.log(`채널 "${channelName}" 이(가) 이미 존재합니다. 생성하지 않습니다.`);
            return existingChannel13 || existingChannel14; // 기존 채널 반환
        }       

        const newChannel = await guild.channels.create({
            name: channelName,
            // type: 'GUILD_TEXT'
            type : 0,
            parent : TORON_CATEGORY_ID
        });
        
        return newChannel;
  
    } catch (error) {
        console.error('채널 생성 실패:', error);
        return null;
    }
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
    const sentMessage = await targetChannel.send(`----------------------------\n [투표 시작]\n ${content}`);
    await reactEmoji(sentMessage);
    await targetChannel.send('----------------------------\n');

    savedVoteResult.set('vote_msgid', sentMessage.id);
    lastVoteContent = content;
}

/**
 * !재투표 : 기존 주제로 재투표 전송
 * @param {재투표 메시지 송신 채널} targetChannel 
 */
async function restartVote(targetChannel) {
    const sentMessage = await targetChannel.send(`----------------------------\n [재투표]\n ${lastVoteContent}`);
    await reactEmoji(sentMessage);
    await targetChannel.send('----------------------------\n');

    savedVoteResult.set('revote_msgid', sentMessage.id);    
}


async function getReactionCounts(targetChannel, messageId) {
    try {
        const message = await targetChannel.messages.fetch(messageId, { force: true });
        const counts = {};

        await Promise.all(
            message.reactions.cache.map(reaction => reaction.users.fetch()) // 사용자 정보를 업데이트
        );

        await Promise.all (
            message.reactions.cache.map(async (reaction) => {
                const refreshed = await reaction.fetch();
                const emoji = refreshed.emoji.name ?? refreshed.emoji.id;
                counts[emoji] = refreshed.count;
            })
        );

        console.log(counts);
        return counts;

    } catch (err) {
        console.error(`메시지 ${messageId}에서 반응 수집 실패`, err);
        return {};
    }
}

async function countVotes(channel, client) {    
    const pastCount = await getReactionCounts(channel, savedVoteResult.get('vote_msgid'));
    const currCount = await getReactionCounts(channel, savedVoteResult.get('revote_msgid'));

    // 모든 이모지 집합 생성
    const allEmojis = new Set([
        ...Object.keys(pastCount),
        ...Object.keys(currCount)
    ]);

    
    let voteResultMsg = `----------------------------\n [투표 결과 비교]\n ${lastVoteContent}\n`;

    for (const emoji of allEmojis) {
        const before = (pastCount[emoji] || 0) - 1;
        const after = (currCount[emoji] || 0) - 1;
        const diff = after - before;
        const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '-';
        voteResultMsg += `${emoji} : ${before} → ${after} (${arrow} ${Math.abs(diff)})\n`;
    }
    voteResultMsg += '----------------------------\n';

    await channel.send(voteResultMsg);

    savedVoteResult.clear();
}

/**
 * 명령어 목록
 */
const commands = {
    '투표' : async (targetChannel, message, args) => {
        const content = args.join(' ');
        if (!content) return message.reply('내용을 입력해주세요.');
        
        try {
            await startVote(targetChannel, content);
            // await vote30sTimer(targetChannel);

        } catch (err) {
            console.error('투표 명령어 오류:', err);
            await message.reply('투표 중 오류가 발생했습니다.');
        }
    },
    
    '재투표': async (targetChannel, message) => {
        if (!lastVoteContent) return message.reply('이전에 실행한 투표 명령어가 없습니다.');

        try {
            restartVote(targetChannel);
            // await vote30sTimer(targetChannel);

        } catch (err) {
            console.error('재투표 명령어 오류:', err);
            message.reply('재투표 중 오류가 발생했습니다.');
        }
    },

    '결과' : async (targetChannel, message, args, client) => {
        if (!(savedVoteResult instanceof Map) || savedVoteResult.size <= 0) {
            console.log('저장된 투표 결과 없음');
            message.reply('저장된 투표 결과가 없습니다.');
            return;
        }
        try {
            await countVotes(targetChannel, client);

        } catch (err) {
            console.error('결과 명령어 오류:', err);
            message.reply('결과 중 오류가 발생했습니다.');
        }        
    },
    
    '발언' : async (targetChannel, message) => {
        try {
            await targetChannel.send(`⏳ ${TORON_TIME}초 간 진행됩니다!`);

            setTimeout(async () => {
                await targetChannel.send('⏰ 종료되었습니다!');
            }, TORON_TIME * 1000); // 60초 = 30000ms

        } catch (err) {
            console.error('발언 명령어 오류:', err);
            message.reply('발언 중 오류가 발생했습니다.');
        }
    },

    '타이머' : async (targetChannel, message, args) => {
        const time = parseInt(args[0], 10);
        voteTimer(targetChannel, message, time)
    }
}


client.on('ready', () => {
  console.log(`✅ 로그인됨: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    const prefix = process.env.PREFIX;
    
    // 봇 메시지 무시
    // if (message.author.bot) return;

    // 지정한 채널이나 명령어가 아닌 경우 무시
    if (message.channel.id !== KEYWORD_CHANNEL_ID && message.channel.id !== COMMAND_CHANNEL_ID) return;
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);;
    const command = args.shift().toLowerCase();

    try {
        const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);

        // 채널 검증
        if (!(await isValidChannel(targetChannel))) return null;

        // 명령어 실행
        if (commands[command]) {
            await commands[command](targetChannel, message, args, client);
        }
    } catch(err) {
        console.error(err);
        message.reply('오류가 발생했습니다.');
    }    

});

client.login(process.env.TOKEN);

