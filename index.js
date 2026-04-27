// ── 1. 모듈 가져오기 ───────────────────────────────────────
const {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType
} = require("discord.js");
const Groq     = require("groq-sdk");
const fetch    = require("node-fetch");
const fs       = require("fs");
const mongoose = require("mongoose");
require("dotenv").config();

// ── 2. 설정값 로드 ─────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY  = process.env.GROQ_API_KEY;
const SERVER_URL    = (process.env.SERVER_URL || "http://localhost:8000").replace(/\/$/, "");
const MONGODB_URI   = process.env.MONGODB_URI || "mongodb://localhost:27017/discord_bot";

// ── 3. MongoDB 연결 및 스키마 ──────────────────────────────
const schoolSchema = new mongoose.Schema({
  guildId:    { type: String, required: true, unique: true },
  schoolCode: { type: String, required: true },
  officeCode: { type: String, required: true },
  schoolName: { type: String, required: true },
  officeName: { type: String, default: "" },
  type:       { type: String, default: "" },
  grade:      { type: String, required: true },
  classNo:    { type: String, required: true },
  updatedAt:  { type: Date,   default: Date.now }
});

const SchoolSetting = mongoose.model("SchoolSetting", schoolSchema);

async function initDb() {
  await mongoose.connect(MONGODB_URI);
  console.log("✅ MongoDB 연결 완료");
}

// ── 4. 학교 설정 저장소 ────────────────────────────────────
const schoolStore  = {};             // 메모리 캐시
const consentStore = new Map();      // userId → true(동의) / false(비동의)

async function getSchool(guildId) {
  if (schoolStore[guildId]) return schoolStore[guildId];

  try {
    const doc = await SchoolSetting.findOne({ guildId });
    if (!doc) return null;
    const data = {
      schoolCode: doc.schoolCode,
      officeCode: doc.officeCode,
      schoolName: doc.schoolName,
      officeName: doc.officeName,
      type:       doc.type,
      grade:      doc.grade,
      classNo:    doc.classNo
    };
    schoolStore[guildId] = data;
    return data;
  } catch {
    return schoolStore[guildId] || null;
  }
}

async function setSchool(guildId, data, saveToDb = false) {
  schoolStore[guildId] = data;
  if (!saveToDb) return;

  try {
    await SchoolSetting.findOneAndUpdate(
      { guildId },
      { ...data, guildId, updatedAt: new Date() },
      { upsert: true, new: true }
    );
  } catch (e) {
    console.error("DB 저장 오류:", e.message);
  }
}

// ── 5. Groq 클라이언트 ────────────────────────────────────
const groq = new Groq({ apiKey: GROQ_API_KEY });

const SYSTEM_PROMPT = `당신은 Discord 서버의 친절한 AI 어시스턴트입니다.
한국어와 영어 모두 유창하게 답변할 수 있습니다.
답변은 간결하고 명확하게 해주세요. Discord 마크다운 형식을 활용해도 됩니다.`;

const conversationHistory = new Map();
const MAX_HISTORY = 10;

// ── 6. KST 날짜 포맷 ──────────────────────────────────────
function kstTodayFormatted() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [y, m, day] = d.split("-");
  return `${y}년 ${m}월 ${day}일`;
}

// ── 7. Groq AI 호출 ───────────────────────────────────────
async function askGroq(channelId, userMessage) {
  if (!conversationHistory.has(channelId)) {
    conversationHistory.set(channelId, []);
  }
  const history = conversationHistory.get(channelId);
  history.push({ role: "user", content: userMessage });

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history]
    });

    const reply = response.choices[0].message.content;
    history.push({ role: "assistant", content: reply });

    while (history.length > MAX_HISTORY * 2) {
      history.splice(0, 2);
    }

    return reply;
  } catch (e) {
    if (history.at(-1)?.role === "user") history.pop();
    return `❌ 오류: ${e.message}`;
  }
}

// ── 8. 학교 검색 ──────────────────────────────────────────
async function searchSchool(name) {
  try {
    const res = await fetch(
      `${SERVER_URL}/api/searchSchool?name=${encodeURIComponent(name)}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    return Array.isArray(data)
      ? data.map(r => ({
          name:       String(r.name       || "").trim(),
          schoolCode: String(r.schoolCode || "").trim(),
          officeCode: String(r.officeCode || "").trim(),
          officeName: String(r.officeName || "").trim(),
          type:       String(r.type       || "학교").trim()
        })).filter(r => r.schoolCode && r.officeCode)
      : [];
  } catch {
    return [];
  }
}

// ── 9. 급식 조회 ──────────────────────────────────────────
async function fetchMeal(schoolCode, officeCode) {
  try {
    const res = await fetch(
      `${SERVER_URL}/api/dailyMeal?schoolCode=${schoolCode}&officeCode=${officeCode}`
    );
    if (!res.ok) return `❌ 서버 오류 (${res.status})`;
    const data = await res.json();
    const menuRaw = data.menu || "";
    if (!menuRaw) return "📭 오늘 급식 정보가 없습니다.";
    return menuRaw
      .replace(/<br\/>/g, "\n")
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => `• ${s}`)
      .join("\n");
  } catch (e) {
    return `❌ 오류: ${e.message}`;
  }
}

// ── 10. 시간표 조회 ───────────────────────────────────────
async function fetchTimetable(schoolCode, officeCode, grade, classNo) {
  try {
    const res = await fetch(
      `${SERVER_URL}/api/dailyTimetable?schoolCode=${schoolCode}&officeCode=${officeCode}&grade=${grade}&classNo=${classNo}`
    );
    if (!res.ok) return `❌ 서버 오류 (${res.status})`;
    const data = await res.json();
    if (!data.length) return "📭 오늘 시간표 정보가 없습니다.";
    return data.map(item => `**${item.period}교시** ${item.subject}`).join("\n");
  } catch (e) {
    return `❌ 오류: ${e.message}`;
  }
}

// ── 11. 긴 메시지 분할 전송 ───────────────────────────────
async function sendLong(interaction, content) {
  const chunks = content.match(/.{1,1990}/gs) || [];
  for (const chunk of chunks) {
    await interaction.followUp(chunk);
  }
}

// ── 12. 개인정보 동의 버튼 생성 ───────────────────────────
function buildConsentComponents(schoolName) {
  const encoded = encodeURIComponent(schoolName);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`consent_agree|${encoded}`)
        .setLabel("동의하고 계속하기")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`consent_disagree|${encoded}`)
        .setLabel("동의하지 않음 (재시작 시 초기화)")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

const PRIVACY_NOTICE = `\`\`\`
📋 개인정보 수집 및 이용 안내

수집 항목 : 서버 ID, 학교명, 학교코드, 교육청코드, 학년, 반
수집 목적 : 봇 재시작 후에도 학교 설정 유지
보관 기간 : 서버에서 학교 설정을 변경하거나 삭제할 때까지
보관 장소 : 봇 운영 MongoDB 데이터베이스

※ 동의하지 않으면 학교 설정은 봇 메모리에만 저장되며
   봇 재시작 시 초기화됩니다.
\`\`\``;

// ── 13. 클라이언트 생성 ───────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ── 14. 슬래시 커맨드 정의 ────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("학교설정")
    .setDescription("학교를 검색하고 설정합니다")
    .addStringOption(o =>
      o.setName("학교명").setDescription("검색할 학교 이름").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("학교확인")
    .setDescription("현재 설정된 학교 정보를 확인합니다"),
  new SlashCommandBuilder()
    .setName("급식")
    .setDescription("오늘 급식 메뉴를 보여줍니다"),
  new SlashCommandBuilder()
    .setName("시간표")
    .setDescription("오늘 시간표를 보여줍니다"),
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("AI와 대화합니다")
    .addStringOption(o =>
      o.setName("message").setDescription("AI에게 보낼 메시지").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("대화 기록을 초기화합니다"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("현재 대화 기록 수를 확인합니다")
].map(c => c.toJSON());

// ── 15. 봇 준비 완료 ──────────────────────────────────────
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Ready! Logged in as ${readyClient.user.tag}`);

  try {
    await initDb();
  } catch (e) {
    console.error("⚠️ MongoDB 연결 실패:", e.message);
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands });
    console.log(`📡 슬래시 커맨드 ${commands.length}개 등록 완료`);
  } catch (e) {
    console.error("⚠️ 슬래시 커맨드 등록 실패:", e.message);
  }
});

// ── 16. 메시지 응답 (멘션 + ping/pong) ───────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.content.includes("ping")) {
    message.reply("pong");
    return;
  }

  if (client.user && message.mentions.has(client.user)) {
    const content = message.content.replace(`<@${client.user.id}>`, "").trim();
    if (!content) {
      await message.reply("안녕하세요! 무엇을 도와드릴까요? 😊");
      return;
    }
    const reply = await askGroq(message.channelId, content);
    if (reply.length > 2000) {
      const chunks = reply.match(/.{1,1990}/gs) || [];
      for (let i = 0; i < chunks.length; i++) {
        i === 0
          ? await message.reply(chunks[i])
          : await message.channel.send(chunks[i]);
      }
    } else {
      await message.reply(reply);
    }
  }
});

// ── 17. 인터랙션 처리 ─────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ── 슬래시 커맨드 ───────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // /학교설정 → 개인정보 동의 먼저 표시
    if (commandName === "학교설정") {
      const 학교명 = interaction.options.getString("학교명");
      await interaction.reply({
        content: `🔍 **학교 설정 전 개인정보 수집 및 이용 동의**\n${PRIVACY_NOTICE}\n**검색할 학교:** ${학교명}`,
        components: buildConsentComponents(학교명),
        ephemeral: true
      });
    }

    // /학교확인
    else if (commandName === "학교확인") {
      const cfg = await getSchool(interaction.guildId);
      if (!cfg) {
        await interaction.reply({
          content: "⚠️ 설정된 학교가 없습니다. `/학교설정`으로 먼저 설정해주세요.",
          ephemeral: true
        });
        return;
      }

      const officeText = cfg.officeName ? `, ${cfg.officeName}` : "";
      const typeText   = cfg.type || "학교";

      await interaction.reply({
        content:
          `🏫 **현재 설정된 학교 정보**\n\n` +
          `📌 학교명: **${cfg.schoolName} (${typeText}${officeText})**\n` +
          `📍 지역: ${cfg.officeName || "알 수 없음"}\n` +
          `🗂️ 종류: ${cfg.type       || "알 수 없음"}\n` +
          `🔢 학교코드: \`${cfg.schoolCode}\`\n` +
          `🏛️ 교육청코드: \`${cfg.officeCode}\`\n` +
          `👤 학년/반: **${cfg.grade}학년 ${cfg.classNo}반**`,
        ephemeral: true
      });
    }

    // /급식
    else if (commandName === "급식") {
      await interaction.deferReply();
      const cfg = await getSchool(interaction.guildId);
      if (!cfg) {
        await interaction.editReply("⚠️ `/학교설정`으로 먼저 학교를 설정해주세요.");
        return;
      }
      const menu = await fetchMeal(cfg.schoolCode, cfg.officeCode);
      await interaction.editReply(
        `🍱 **${kstTodayFormatted()} 급식** (${cfg.schoolName})\n\n${menu}`
      );
    }

    // /시간표
    else if (commandName === "시간표") {
      await interaction.deferReply();
      const cfg = await getSchool(interaction.guildId);
      if (!cfg) {
        await interaction.editReply("⚠️ `/학교설정`으로 먼저 학교를 설정해주세요.");
        return;
      }
      const table = await fetchTimetable(
        cfg.schoolCode, cfg.officeCode, cfg.grade, cfg.classNo
      );
      await interaction.editReply(
        `📚 **${kstTodayFormatted()} 시간표** (${cfg.schoolName} ${cfg.grade}학년 ${cfg.classNo}반)\n\n${table}`
      );
    }

    // /chat
    else if (commandName === "chat") {
      await interaction.deferReply();
      const msg = interaction.options.getString("message");
      const reply = await askGroq(interaction.channelId, msg);
      await sendLong(interaction, `**You:** ${msg}\n\n${reply}`);
    }

    // /clear
    else if (commandName === "clear") {
      conversationHistory.delete(interaction.channelId);
      await interaction.reply({
        content: "🗑️ 대화 기록이 초기화되었습니다!",
        ephemeral: true
      });
    }

    // /status
    else if (commandName === "status") {
      const count = Math.floor(
        (conversationHistory.get(interaction.channelId)?.length || 0) / 2
      );
      await interaction.reply({
        content: `💬 현재 채널 대화 기록: **${count}턴** (최대 ${MAX_HISTORY}턴)`,
        ephemeral: true
      });
    }
  }

  // ── 개인정보 동의 버튼 ──────────────────────────────────
  else if (interaction.isButton()) {
    const [action, encodedName] = interaction.customId.split("|");
    const schoolName = decodeURIComponent(encodedName || "");

    if (action === "consent_agree" || action === "consent_disagree") {
      const agreed = action === "consent_agree";
      consentStore.set(interaction.user.id, agreed);

      await interaction.deferUpdate();

      const results = await searchSchool(schoolName);
      if (!results.length) {
        await interaction.editReply({
          content: "❌ 검색 결과가 없습니다. 학교명을 다시 확인해주세요.",
          components: []
        });
        return;
      }

      const options = results.slice(0, 25).map(r => {
        const officeText = r.officeName ? `, ${r.officeName}` : "";
        const label = `${r.name} (${r.type}${officeText})`;
        return {
          label:       label.slice(0, 100),
          description: r.officeName || r.type || "",
          value:       `${r.schoolCode}|${r.officeCode}|${r.name}|${r.officeName}|${r.type}`
        };
      });

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("school_select")
          .setPlaceholder("학교를 선택하세요")
          .addOptions(options)
      );

      const consentMsg = agreed
        ? "✅ 동의하셨습니다. 학교 설정이 DB에 저장됩니다."
        : "⚠️ 미동의 상태입니다. 봇 재시작 시 설정이 초기화됩니다.";

      await interaction.editReply({
        content: `${consentMsg}\n\n🔍 **'${schoolName}'** 검색 결과 ${results.length}개\n아래에서 학교를 선택하세요:`,
        components: [row]
      });
    }
  }

  // ── Select Menu (학교 선택) ──────────────────────────────
  else if (interaction.isStringSelectMenu() && interaction.customId === "school_select") {
    const [schoolCode, officeCode, schoolName, officeName, type] =
      interaction.values[0].split("|");

    const modal = new ModalBuilder()
      .setCustomId(`grade_modal|${schoolCode}|${officeCode}|${schoolName}|${officeName}|${type}`)
      .setTitle("학년 / 반 설정")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("grade")
            .setLabel("학년")
            .setPlaceholder("예: 2")
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(1)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("class_no")
            .setLabel("반")
            .setPlaceholder("예: 3")
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(2)
            .setRequired(true)
        )
      );

    await interaction.showModal(modal);
  }

  // ── Modal Submit (학년/반 저장) ──────────────────────────
  else if (
    interaction.type === InteractionType.ModalSubmit &&
    interaction.customId.startsWith("grade_modal|")
  ) {
    const [, schoolCode, officeCode, schoolName, officeName, type] =
      interaction.customId.split("|");
    const grade   = interaction.fields.getTextInputValue("grade").trim();
    const classNo = interaction.fields.getTextInputValue("class_no").trim();
    const agreed  = consentStore.get(interaction.user.id) === true;

    await setSchool(interaction.guildId, {
      schoolCode,
      officeCode,
      schoolName,
      officeName: officeName || "",
      type:       type       || "학교",
      grade,
      classNo
    }, agreed);

    const officeText  = officeName ? `, ${officeName}` : "";
    const saveMessage = agreed
      ? "💾 설정이 DB에 저장되었습니다. (봇 재시작 후에도 유지)"
      : "⚡ 설정이 메모리에만 저장되었습니다. (봇 재시작 시 초기화)";

    await interaction.reply({
      content:
        `✅ **${schoolName} (${type}${officeText})**\n` +
        `${grade}학년 ${classNo}반으로 설정되었습니다!\n\n${saveMessage}`,
      ephemeral: true
    });
  }
});

// ── 18. 실행 ──────────────────────────────────────────────
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN이 설정되지 않았습니다!");
  process.exit(1);
} else if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY가 설정되지 않았습니다!");
  process.exit(1);
} else {
  client.login(DISCORD_TOKEN);
}
