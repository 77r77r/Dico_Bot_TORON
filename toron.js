require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const keywordEmoji = [
    '🇦', '🇧', '🇵'
];

/**
 * 원본 메시지가 온 채널 ID (예: 복사할 메시지 감지 채널) : sourceChannelId
 * 메시지를 보낼 대상 채널 ID (복사본 채널) :targetChannelId
 */

const SERVER_ID = process.env.SERVER_ID;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID; // real
// const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;    // 테스트
// const KEYWORD_CHANNEL_ID = process.env.KEYWORD_CHANNEL_ID;   // 명렁어 채널
const KEYWORD_CHANNEL_ID = process.env.KEYWORD_CHANNEL_ID;
const TORON_CATEGORY_ID = process.env.TORON_CATEGORY_ID;



const VOTE_TIME = 30;    // 30초
const TORON_TIME = 180;   // 180초

// 전역에 저장할 변수 (메모리 기반, 서버 재시작 시 초기화됨)
let lastVoteContent = null;
let savedVoteResult = new Map();

// 채널 검증
async function isValidChannel(client, channelId, message) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
            if (message) await message.reply('유효한 대상 채널이 아닙니다.');
            return false;
        }
        return true;
    } catch (error) {
        console.error('채널 확인 중 오류:', error);
        if (message) await message.reply('채널 확인 중 오류가 발생했습니다.');
        return false;
    }
}


async function vote30sTimer(client, message) {
    try {
        if (!(await isValidChannel(client, TARGET_CHANNEL_ID, message))) {
            return null;
        }

        const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
        await targetChannel.send('----------------------------\n ⏳ 30초간 진행됩니다!\n----------------------------\n');

        setTimeout(async () => {
            await targetChannel.send('----------------------------\n ⏰ 종료되었습니다!\n----------------------------\n');
        }, VOTE_TIME * 1000); // 30초 = 30000ms

    } catch (err) {
        console.error('time30s 명령어 오류:', err);
        message.reply('타이머 실행 중 오류가 발생했습니다.');
    }
}

async function voteTimer(client, message, time) {
    try {
        if (!(await isValidChannel(client, TARGET_CHANNEL_ID, message))) {
            return null;
        }

        const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
        await targetChannel.send(`----------------------------\n ⏳ ${time} 초간 진행됩니다!\n----------------------------\n`);

        setTimeout(async () => {
            await targetChannel.send('----------------------------\n ⏰ 종료되었습니다!\n----------------------------\n');
        }, time * 1000);
    } catch (err) {
        console.error('time30s 명령어 오류:', err);
        message.reply('타이머 실행 중 오류가 발생했습니다.');
    }
}

async function getReactionCounts(messageId, channel) {
    const msg = await channel.messages.fetch(messageId);
    const counts = {};

    msg?.reactions?.cache?.forEach?.(reaction => {
        counts[reaction.emoji.name] = reaction.count;
    });
    return counts;
}

async function countVotes(client) {
    if (!(savedVoteResult instanceof Map) || savedVoteResult.size <= 0) {
        console.log('투표 결과가 없습니다.');
        return;
    }

    
    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
    
    const pastCount = await getReactionCounts(savedVoteResult.get('Past-id'), channel);
    const currCount = await getReactionCounts(savedVoteResult.get('Curr-id'), channel);

    console.log('Past-id:', savedVoteResult.get('Past-id'));
    console.log('Curr-id:', savedVoteResult.get('Curr-id'));    

    // 모든 이모지 집합 생성
    const allEmojis = new Set([
        ...Object.keys(pastCount),
        ...Object.keys(currCount)
    ]);

    
    let voteResultMsg = '----------------------------\n [투표 결과 비교]\n';

    for (const emoji of allEmojis) {
        const before = (pastCount[emoji] || 0) - 1;
        const after = (currCount[emoji] || 0) - 1;
        const diff = after - before;
        const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '-';
        voteResultMsg += `${emoji} : ${before} → ${after} (${arrow} ${Math.abs(diff)})\n`;
    }
    voteResultMsg += '----------------------------\n';

    await channel.send(voteResultMsg);
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


const prefix = '!';

const commands = {
    '투표' : async (message, args) => {
        const content = args.join(' ');

        if (!content) return message.reply('전송할 메시지를 입력해주세요.');

        try {
            if (!(await isValidChannel(client, TARGET_CHANNEL_ID, message))) {
                return null;
            }
            const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
            const sentMessage = await targetChannel.send(`----------------------------\n [투표 시작]\n ${content}`);

            savedVoteResult.set('Past-id', sentMessage.id);
            lastVoteContent = content;

            const reactEmoji = keywordEmoji.map((emoji) => sentMessage.react(emoji));
            await Promise.allSettled(reactEmoji);
            // await vote30sTimer(client, message);

        } catch (err) {
            console.error('투표 명령어 오류:', err);
            message.reply('투표 중 오류가 발생했습니다.');
        }
    },
    
    '재투표': async (message, args) => {
        if (!lastVoteContent) {
            return message.reply('이전에 실행한 투표 명령어가 없습니다.');
        }

        try {
            if (!(await isValidChannel(client, TARGET_CHANNEL_ID, message))) {
                return null;
            }

            const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
            const sentMessage = await targetChannel.send(`----------------------------\n [재투표]\n ${lastVoteContent}`);

            savedVoteResult.set('Curr-id', sentMessage.id);
            
            // 이모지 반응 달기
            const reactEmoji = keywordEmoji.map((emoji) => sentMessage.react(emoji));
            await Promise.allSettled(reactEmoji);
            await vote30sTimer(client, message);

        } catch (err) {
            console.error('재투표 명령어 오류:', err);
            message.reply('재전송 중 오류가 발생했습니다.');
        }
    },

    '발언' : async (message, args) => {
        try {
            if (!(await isValidChannel(client, TARGET_CHANNEL_ID, message))) {
                return null;
            }
            
            const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
            await targetChannel.send(`⏳ ${TORON_TIME}초 간 진행됩니다!`);

            setTimeout(async () => {
                await targetChannel.send('⏰ 종료되었습니다!');
            }, TORON_TIME * 1000); // 60초 = 30000ms

        } catch (err) {
            console.error('발언 명령어 오류:', err);
            message.reply('발언 중 오류가 발생했습니다.');
        }
    },

    '결과' : async (message, args) => {
        countVotes(client);
    },

    '타이머' : async (message, args) => {
        const time = parseInt(args[0], 10);
        voteTimer(client, message, time)
    }
}


client.on('ready', () => {
  console.log(`✅ 로그인됨: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    // 봇 메시지 무시
    // if (message.author.bot) return;


    // 지정된 채널이 아니면 종료
    if (message.channel.id !== KEYWORD_CHANNEL_ID) return;

    // ! 명령어가 아닌 경우 무시
    if (!message.content.startsWith(prefix)) return;

    //
    const args = message.content.slice(prefix.length).trim().split(/ +/);;
    const command = args.shift().toLowerCase();

    if (commands[command]) {
        await commands[command](message, args);
    }

});

client.login(process.env.TOKEN);

