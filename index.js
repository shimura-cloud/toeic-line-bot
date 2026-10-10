const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

function getUserLevel(correctCount) {
  if (correctCount < 10) return { level: 1, title: "文法見習い 🐣", nextReq: 10 };
  if (correctCount < 30) return { level: 2, title: "Part5 チャレンジャー 🏃", nextReq: 30 };
  if (correctCount < 50) return { level: 3, title: "文法マスター 🎯", nextReq: 50 };
  return { level: 4, title: "Part5 覇者 👑", nextReq: null };
}

// 既存の6ジャンル ＋ 新規3ジャンルをすべて統合！
function getGenreQuickReply() {
  const genres = [
    "品詞識別", 
    "動詞・時制", 
    "代名詞", 
    "接続詞・前置詞", 
    "語彙・コロケーション", 
    "分詞・関係詞・比較", 
    "文型・文構造", 
    "語彙・同意語", 
    "語彙・言い換え", 
    "弱点克服モード"
  ];
  return {
    items: genres.map(g => ({
      type: 'action',
      action: { type: 'message', label: g, text: `【ジャンル】${g}` }
    }))
  };
}

app.post('/webhook', line.middleware(config), async (req, res) => {
  const events = req.body.events;
  const client = new line.Client(config);

  for (let event of events) {
    const userId = event.source.userId;

    // A. ポストバックイベント（ボタンタップ処理）
    if (event.type === 'postback') {
      const dataStr = event.postback.data;

      // 1. リセット実行処理
      if (dataStr === 'ACTION_CONFIRM_RESET') {
        try {
          const { data: currentLogs } = await supabase
            .from("user_logs")
            .select("*")
            .eq("user_id", userId);

          if (currentLogs && currentLogs.length > 0) {
            const archiveData = currentLogs.map(log => ({
              user_id: log.user_id,
              content_id: log.content_id,
              is_correct: log.is_correct,
              reset_at: new Date()
            }));

            await supabase.from("archived_logs").insert(archiveData);
            await supabase.from("user_logs").delete().eq("user_id", userId);

            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: "これまでの解答履歴を保存し、ステータスをリセットしました！\n新たな気持ちで「問題」と送ってスタートしましょう 🚀"
            });
          } else {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: "リセット対象の学習データがありません。"
            });
          }
        } catch (err) {
          console.error("リセット処理エラー:", err);
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: "リセット処理中にエラーが発生しました。"
          });
        }
        continue;
      }

      // 2. 問題の解答処理
      if (dataStr.startsWith("解答:")) {
        const parts = dataStr.split(":");
        const contentId = parts[1];
        const userChoice = parts[2] ? parts[2].toUpperCase().trim() : '';

        if (contentId && userChoice) {
          let q = null;
          const { data: idRes } = await supabase.from("contents").select("*").eq("id", contentId);
          
          if (idRes && idRes.length > 0) {
            q = idRes[0];
          } else {
            const { data: allRes } = await supabase.from("contents").select("*");
            if (allRes) q = allRes.find(item => String(item.id) === String(contentId) || String(item.stem) === String(contentId));
          }

          if (q) {
            const correctChoice = (q.correct_choice || q.correct_ch || q.answer || '').toString().trim().toUpperCase();
            const isCorrect = (userChoice === correctChoice);

            try {
              await supabase.from("user_logs").insert({
                user_id: userId,
                content_id: q.id || 0,
                is_correct: isCorrect
              });
            } catch (logErr) {
              console.log(`⚠️ ログ保存警告: ${logErr}`);
            }

            const { data: logs } = await supabase.from("user_logs").select("is_correct").eq("user_id", userId);
            const totalCorrect = logs ? logs.filter(log => log.is_correct).length : 0;
            const lvlInfo = getUserLevel(totalCorrect);

            const resultMark = isCorrect ? "⭕ **正解！**" : `❌ **不正解...** (正解: **${correctChoice}**)`;
            const lvlMsg = lvlInfo.nextReq 
              ? `🏆 **Lv.${lvlInfo.level} [${lvlInfo.title}]** (次レベルまであと ${lvlInfo.nextReq - totalCorrect} 問正解)`
              : `🏆 **Lv.${lvlInfo.level} [${lvlInfo.title}]** (最高ランク到達！)`;

            let explanation = `${resultMark}\n\n` +
              `${lvlMsg}\n` +
              `------------------------------\n`;

            if (q.q_doubt) {
              explanation += `🧠 **【ハマりポイント】**\n${q.q_doubt}\n\n`;
            }
            if (q.ai_correct || q.explanation) {
              explanation += `💡 **【解説】**\n${q.ai_correct || q.explanation}\n\n`;
            }
            if (q.ai_wrong) {
              explanation += `⚠️ **【罠指摘】**\n${q.ai_wrong}\n\n`;
            }
            if (q.q_convinced) {
              explanation += `🎯 **【納得ワンポイント】**\n${q.q_convinced}`;
            }

            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: explanation.trim(),
              quickReply: getGenreQuickReply()
            });
            continue;
          }
        }
      }
    }

    // B. テキストメッセージイベント
    if (event.type === 'message' && event.message.type === 'text') {
      const userText = event.message.text.trim();

      // 1. リセット確認コマンド
      if (userText === "リセット") {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: "⚠️ **学習データのリセット**\n\nこれまでの解答履歴を保存（アーカイブ）し、レベルや進捗をLv.1に戻しますか？",
          quickReply: {
            items: [
              {
                type: 'action',
                action: {
                  type: 'postback',
                  label: '実行する',
                  data: 'ACTION_CONFIRM_RESET',
                  displayText: 'リセットを実行する'
                }
              }
            ]
          }
        });
        continue;
      }

      // 2. ジャンル選択
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
          const { data: logs } = await supabase.from("user_logs").select("is_correct").eq("user_id", userId);

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
            const nextStr = lvlInfo.nextReq ? `あと ${lvlInfo.nextReq - correctCount} 問正解でレベルアップ！` : "最高ランクに到達済みです！";

            const replyText = `👤 **【あなたの学習ステータス】**\n\n` +
              `🎖️ **称号**: ${lvlInfo.title}\n` +
              `⭐ **レベル**: Lv.${lvlInfo.level}\n` +
              `🚀 **進捗**: ${nextStr}\n\n` +
              `------------------------------\n` +
              `📝 総解答数: ${total} 問\n` +
              `⭕ 正解数: ${correctCount} 問\n` +
              `🎯 全体正解率: ${accuracy} %\n\n` +
              `「ジャンル」から苦手分野を選んでどんどんレベルを上げましょう！`;

            await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
          }
        } catch (e) {
          await client.replyMessage(event.replyToken, { type: 'text', text: "マイページデータの読み込みに失敗しました。" });
        }
        continue;
      }

      // 4. 出題処理
      let targetCategory = null;
      if (userText.startsWith("【ジャンル】")) {
        targetCategory = userText.replace("【ジャンル】", "");
      }

      if (userText === "問題" || targetCategory) {
        const { data: contentsRes } = await supabase.from("contents").select("*");

        if (!contentsRes || contentsRes.length === 0) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: "申し訳ありません。問題データがありません。"
          });
          continue;
        }

        let candidateQuestions = contentsRes;
        
        if (targetCategory && targetCategory !== "弱点克服モード") {
          const newCategories = ["文型・文構造", "語彙・同意語", "語彙・言い換え"];
          
          if (newCategories.includes(targetCategory)) {
            // ★ 新規追加の3ジャンルの場合は category_name で絞り込み
            candidateQuestions = contentsRes.filter(q => q.category_name === targetCategory);
          } else {
            // ★ 既存の6ジャンルの場合は rules テーブル参照で絞り込み（旧ロジックを維持！）
            try {
              const { data: rulesRes } = await supabase.from("rules").select("rule_id, category").eq("category", targetCategory);
              if (rulesRes && rulesRes.length > 0) {
                const targetRuleIds = rulesRes.map(r => (r.rule_id || '').trim().toUpperCase());
                candidateQuestions = contentsRes.filter(q => targetRuleIds.includes((q.rule_id || '').trim().toUpperCase()));
              }
            } catch (catErr) {
              console.log(`⚠️ カテゴリ絞り込み警告: ${catErr}`);
            }
          }
        }

        if (!candidateQuestions || candidateQuestions.length === 0) {
          candidateQuestions = contentsRes;
        }

        const q = candidateQuestions[Math.floor(Math.random() * candidateQuestions.length)];
        const targetId = q.id !== undefined && q.id !== null ? q.id : encodeURIComponent(q.stem);

        const msg = `【TOEIC Part5】\n\n` +
          `${q.stem}\n\n` +
          `(A) ${q.choice_a}\n` +
          `(B) ${q.choice_b}\n` +
          `(C) ${q.choice_c}\n` +
          `(D) ${q.choice_d}`;

        const ansItems = ["A", "B", "C", "D"].map(opt => ({
          type: 'action',
          action: {
            type: 'postback',
            label: opt,
            data: `解答:${targetId}:${opt}`,
            displayText: opt
          }
        }));

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: msg,
          quickReply: { items: ansItems }
        });
        continue;
      }

      // 5. デフォルト返信
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: `「問題」と送信するとTOEIC問題が出題されます！\n「マイページ」や「ジャンル」、「リセット」も試してみてください。`
      });
    }
  }
  res.status(200).end();
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
