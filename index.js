const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Python版と同じメモリ保持辞書
const userCurrentQ = {};

// --- レベル・称号判定ロジック ---
function getUserLevel(correctCount) {
  if (correctCount < 10) {
    return { level: 1, title: "文法見習い 🐣", nextReq: 10 };
  } else if (correctCount < 30) {
    return { level: 2, title: "Part5 チャレンジャー 🏃", nextReq: 30 };
  } else if (correctCount < 50) {
    return { level: 3, title: "文法マスター 🎯", nextReq: 50 };
  } else {
    return { level: 4, title: "Part5 覇者 👑", nextReq: null };
  }
}

// --- ジャンル選択クイックリプライ ---
function getGenreQuickReply() {
  const genres = ["品詞識別", "動詞・時制", "代名詞", "接続詞・前置詞", "語彙・コロケーション", "分詞・関係詞・比較", "弱点克服モード"];
  return {
    items: genres.map(g => ({
      type: 'action',
      action: {
        type: 'message',
        label: g,
        text: `【ジャンル】${g}`
      }
    }))
  };
}

app.post('/webhook', line.middleware(config), async (req, res) => {
  const events = req.body.events;
  const client = new line.Client(config);

  for (let event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const userText = event.message.text.trim();
      let userChoice = userText.toUpperCase();

      console.log(`📩 受信メッセージ: ${userText}`);

      // 1. 解答処理
      if (["A", "B", "C", "D"].includes(userChoice) || userText.startsWith("解答:")) {
        let contentId = null;

        if (userText.startsWith("解答:")) {
          const parts = userText.split(":");
          if (parts.length >= 3) {
            contentId = parseInt(parts[1]);
            userChoice = parts[2].toUpperCase().trim();
          }
        } else {
          contentId = userCurrentQ[userId];
        }

        if (contentId) {
          const { data: res } = await supabase
            .from("contents")
            .select("*")
            .eq("id", contentId);

          if (res && res.length > 0) {
            const q = res[0];
            const correctChoice = (q.correct_choice || '').toString().trim().toUpperCase();
            const isCorrect = (userChoice === correctChoice);

            // ログ保存
            try {
              await supabase.from("user_logs").insert({
                user_id: userId,
                content_id: contentId,
                is_correct: isCorrect
              });
            } catch (logErr) {
              console.log(`⚠️ ログ保存警告: ${logErr}`);
            }

            // 通算正解数取得
            const { data: logs } = await supabase
              .from("user_logs")
              .select("is_correct")
              .eq("user_id", userId);

            const totalCorrect = logs ? logs.filter(log => log.is_correct).length : 0;
            const lvlInfo = getUserLevel(totalCorrect);

            const resultMark = isCorrect ? "⭕ **正解！**" : `❌ **不正解...** (正解: **${q.correct_choice}**)`;
            
            let lvlMsg = "";
            if (lvlInfo.nextReq) {
              const remain = lvlInfo.nextReq - totalCorrect;
              lvlMsg = `🏆 **Lv.${lvlInfo.level} [${lvlInfo.title}]** (次レベルまであと ${remain} 問正解)`;
            } else {
              lvlMsg = `🏆 **Lv.${lvlInfo.level} [${lvlInfo.title}]** (最高ランク到達！)`;
            }

            const explanation = `${resultMark}\n\n` +
              `${lvlMsg}\n` +
              `------------------------------\n` +
              `🧠 **【ハマりポイント】**\n${q.q_doubt || ''}\n\n` +
              `💡 **【解説】**\n${q.ai_correct || ''}\n\n` +
              `⚠️ **【罠指摘】**\n${q.ai_wrong || ''}\n\n` +
              `🎯 **【納得ワンポイント】**\n${q.q_convinced || ''}`;

            delete userCurrentQ[userId];

            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: explanation,
              quickReply: getGenreQuickReply()
            });
            continue;
          }
        }
      }

      // 2. ジャンル選択メニュー
      if (["ジャンル", "メニュー", "カテゴリ"].includes(userText)) {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: "挑戦したい文法ジャンルを選択してください👇",
          quickReply: getGenreQuickReply()
        });
        continue;
      }

      // 3. マイページ
      if (userText === "マイページ") {
        try {
          const { data: logs } = await supabase
            .from("user_logs")
            .select("is_correct")
            .eq("user_id", userId);

          if (!logs || logs.length === 0) {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: "まだ解答履歴がありません。「問題」または「ジャンル」と送って挑戦してみましょう！"
            });
          } else {
            const total = logs.length;
            const correctCount = logs.filter(log => log.is_correct).length;
            const accuracy = ((correctCount / total) * 100).toFixed(1);

            const lvlInfo = getUserLevel(correctCount);
            const nextStr = lvlInfo.nextReq 
              ? `あと ${lvlInfo.nextReq - correctCount} 問正解でレベルアップ！` 
              : "最高ランクに到達済みです！";

            const replyText = `👤 **【あなたの学習ステータス】**\n\n` +
              `🎖️ **称号**: ${lvlInfo.title}\n` +
              `⭐ **レベル**: Lv.${lvlInfo.level}\n` +
              `🚀 **進捗**: ${nextStr}\n\n` +
              `------------------------------\n` +
              `📝 総解答数: ${total} 問\n` +
              `⭕ 正解数: ${correctCount} 問\n` +
              `🎯 全体正解率: ${accuracy} %\n\n` +
              `「ジャンル」から苦手分野を選んでどんどんレベルを上げましょう！`;

            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: replyText
            });
          }
        } catch (e) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: "マイページデータの読み込みに失敗しました。"
          });
        }
        continue;
      }

      // 4. 出題処理
      let targetCategory = null;
      if (userText.startsWith("【ジャンル】")) {
        targetCategory = userText.replace("【ジャンル】", "");
      }

      if (userText === "問題" || targetCategory) {
        const { data: contentsRes } = await supabase
          .from("contents")
          .select("*");

        if (!contentsRes || contentsRes.length === 0) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: "申し訳ありません。問題データがありません。"
          });
          continue;
        }

        let candidateQuestions = [];
        if (targetCategory && targetCategory !== "弱点克服モード") {
          try {
            const { data: rulesRes } = await supabase
              .from("rules")
              .select("rule_id, category")
              .eq("category", targetCategory);

            if (rulesRes && rulesRes.length > 0) {
              const targetRuleIds = rulesRes.map(r => (r.rule_id || '').trim().toUpperCase());
              candidateQuestions = contentsRes.filter(q => 
                targetRuleIds.includes((q.rule_id || '').trim().toUpperCase())
              );
            }
          } catch (catErr) {
            console.log(`⚠️ カテゴリ絞り込み警告: ${catErr}`);
          }
        }

        if (!candidateQuestions || candidateQuestions.length === 0) {
          candidateQuestions = contentsRes;
        }

        // ランダム選定
        const q = candidateQuestions[Math.floor(Math.random() * candidateQuestions.length)];
        userCurrentQ[userId] = q.id;

        const msg = `【TOEIC Part5】\n\n` +
          `${q.stem}\n\n` +
          `(A) ${q.choice_a}\n` +
          `(B) ${q.choice_b}\n` +
          `(C) ${q.choice_c}\n` +
          `(D) ${q.choice_d}`;

        const ansItems = ["A", "B", "C", "D"].map(opt => ({
          type: 'action',
          action: {
            type: 'message',
            label: opt,
            text: opt
          }
        }));

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: msg,
          quickReply: { items: ansItems }
        });
        continue;
      }
    }
  }
  res.status(200).end();
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
