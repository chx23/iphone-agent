import type { AgentAction, ParsedIntent, RiskDecision, RiskLevel, WhitelistEntry } from "../../shared/types";

const sensitivePatterns = [
  /支付|付款|转账|红包|收款|提现|银行卡|验证码/,
  /删除|注销|退出登录|改密码|修改密码|账号|隐私/,
  /发布|公开|朋友圈|评论|评价|下单|确认订单/
];

export interface RiskAssessment {
  decision: RiskDecision;
  level: RiskLevel;
  reason: string;
}

export function assessRisk(input: {
  action: AgentAction;
  intent: ParsedIntent;
  whitelist: WhitelistEntry[];
  advancedAutoMode: boolean;
}): RiskAssessment {
  const { action, intent, whitelist, advancedAutoMode } = input;
  const actionText = JSON.stringify(action);
  const instructionText = intent.rawInstruction;
  const contact = intent.delivery?.name ?? intent.contact;

  if (advancedAutoMode && !/支付|转账|删除|注销|改密码/.test(`${actionText} ${instructionText}`)) {
    return { decision: "allow", level: "medium", reason: "高级全自动模式已开启。" };
  }

  if (sensitivePatterns.some((pattern) => pattern.test(`${actionText} ${instructionText}`))) {
    return { decision: "confirm", level: "critical", reason: "涉及敏感提交，必须最终确认。" };
  }

  if ((intent.kind === "wechat_article_summary" || intent.kind === "wechat_message") && action.type === "input" && contact) {
    if (intent.kind === "wechat_message" && action.text === contact) {
      return { decision: "allow", level: "low", reason: "输入联系人名称用于微信搜索导航。" };
    }

    const trusted = whitelist.some((entry) => entry.autoSend && entry.label === contact);
    if (!trusted) {
      return { decision: "confirm", level: "high", reason: "目标联系人不在自动发送白名单。" };
    }
  }

  if (action.type === "open_url" && !/^https?:\/\//i.test(action.url)) {
    return { decision: "confirm", level: "medium", reason: "准备打开非 HTTP 链接。" };
  }

  if (action.type === "tap_xy") {
    return { decision: "allow", level: "low", reason: "普通点击。" };
  }

  return { decision: "allow", level: "low", reason: "常规任务内操作。" };
}
