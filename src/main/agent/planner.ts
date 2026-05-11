import type { AgentAction, ElementRef, ParsedIntent, ScreenGraph, TaskPhase } from "../../shared/types";
import { findElement } from "../screenGraph";
import { detectWechatArticleSurface } from "./wechatArticleSurface";

export interface PlannerOutput {
  action: AgentAction;
  description: string;
  expectedResult: string;
  confidence: number;
  phase?: TaskPhase;
  route?: string;
  guardReason?: string;
  progressKey?: string;
}

export interface PlannerContext {
  phase?: TaskPhase;
  route?: string;
  noProgressCount?: number;
  lastScreenSignature?: string;
}

interface ScreenFacts {
  isTargetActive: boolean;
  isWechat: boolean;
  isWechatMainPage: boolean;
  isWechatContactsPage: boolean;
  isWechatOfficialAccountsList: boolean;
  isWechatSearchScreen: boolean;
  isWechatNoFriendSearchResults: boolean;
  isWechatResidualSearchResultsPage: boolean;
  isWechatGlobalSearchOrAiPage: boolean;
  isWechatArticleScreen: boolean;
  isWechatAccountHome: boolean;
  isWechatLivePreviewPage: boolean;
  isLikelyWechatVideoFeed: boolean;
  isWechatChatConversation: boolean;
  isWechatChatWithContact: boolean;
  searchQuery?: string;
}

interface SkillDecision {
  action: AgentAction;
  description: string;
  expectedResult: string;
  confidence: number;
  phase: TaskPhase;
  route: string;
  guardReason?: string;
  progressKey?: string;
}

interface RouteAttempt {
  route: string;
  noProgressCount: number;
}

export function fallbackPlan(intent: ParsedIntent, screen: ScreenGraph, _stepIndex: number, context: PlannerContext = {}): PlannerOutput {
  const facts = buildScreenFacts(intent, screen);
  if (intent.kind === "generic" && intent.targetApp && intent.targetApp !== "unknown") {
    if (facts.isTargetActive) {
      const appName = intent.targetApp === "wechat" ? "微信" : "大众点评";
      return resolveDecision({
        action: { type: "finish", summary: `已打开${appName}。` },
        description: `已确认${appName}在前台。`,
        expectedResult: "任务完成。",
        confidence: 0.92,
        phase: "verify_done",
        route: `${intent.targetApp}:active`,
        progressKey: `finish:${intent.targetApp}`
      });
    }
    return openTargetAppDecision(intent, facts);
  }

  if (intent.kind === "wechat_article_summary") {
    return resolveDecision(planWechatArticle(intent, screen, facts, context));
  }

  if (intent.kind === "wechat_message" && deliveryContactName(intent)) {
    return resolveDecision(planWechatMessage(intent, screen, facts, context));
  }

  if (intent.kind === "dianping_food_search") {
    return resolveDecision(planDianpingFoodSearch(intent, screen, facts));
  }

  if (intent.targetApp && intent.targetApp !== "unknown" && !facts.isTargetActive) {
    return openTargetAppDecision(intent, facts);
  }

  return minimalFallbackPlan(intent, screen);
}

function buildScreenFacts(intent: ParsedIntent, screen: ScreenGraph): ScreenFacts {
  const account = officialAccountName(intent);
  const contact = deliveryContactName(intent);
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  return {
    isTargetActive: Boolean(intent.targetApp && intent.targetApp !== "unknown" && isTargetAppActive(intent.targetApp, screen)),
    isWechat: isWechatScreen(screen),
    isWechatMainPage: isWechatMainPage(screen),
    isWechatContactsPage: isWechatContactsPage(screen),
    isWechatOfficialAccountsList: isWechatOfficialAccountsList(screen),
    isWechatSearchScreen: isWechatSearchScreen(screen),
    isWechatNoFriendSearchResults: isWechatNoFriendSearchResults(screen),
    isWechatResidualSearchResultsPage: isWechatResidualSearchResultsPage(screen),
    isWechatGlobalSearchOrAiPage: isWechatGlobalSearchOrAiPage(screen),
    isWechatArticleScreen: isWechatArticleScreen(screen, account),
    isWechatAccountHome: isWechatAccountHome(screen, account),
    isWechatLivePreviewPage: isWechatLivePreviewPage(screen),
    isLikelyWechatVideoFeed: isLikelyWechatVideoFeed(screen),
    isWechatChatConversation: isLikelyWechatChatConversation(labels, text),
    isWechatChatWithContact: contact ? isWechatChatScreen(screen, contact) : false,
    searchQuery: findWechatSearchQuery(screen)
  };
}

function planWechatArticle(intent: ParsedIntent, screen: ScreenGraph, facts: ScreenFacts, context: PlannerContext): SkillDecision {
  const account = officialAccountName(intent);
  if (!facts.isWechat) {
    return openWechatDecision("打开微信，准备查找公众号。");
  }

  const backButton = findElement(screen, "返回");
  if (facts.isWechatChatConversation) {
    return {
      action: backButton?.bounds ? { type: "tap_element", elementId: backButton.id } : { type: "back" },
      description: "当前是聊天页，先返回微信页面再继续查找公众号。",
      expectedResult: "回到微信会话列表、通讯录或搜索入口。",
      confidence: 0.68,
      phase: "locate_source",
      route: "wechat:exit_chat",
      guardReason: "公众号阅读阶段屏蔽收件人目标，不能点击联系人。",
      progressKey: "article:exit_chat"
    };
  }

  if (facts.isWechatArticleScreen) {
    return {
      action: { type: "collect_scroll", direction: "down", maxScrolls: 1 },
      description: "已进入公众号文章页，继续下滑阅读全文后再总结。",
      expectedResult: "采集到下一屏正文，直到读到底部再生成摘要。",
      confidence: 0.72,
      phase: "read_article",
      route: "wechat:current_article",
      progressKey: "article:read:down"
    };
  }

  if (facts.isLikelyWechatVideoFeed || facts.isWechatLivePreviewPage) {
    return {
      action: backButton?.bounds ? { type: "tap_element", elementId: backButton.id } : { type: "back" },
      description: facts.isWechatLivePreviewPage ? "当前是直播预告或预约页，先返回公众号主页继续找图文文章。" : "当前像是视频/看一看页面，先返回公众号或搜索页继续找文章。",
      expectedResult: "回到公众号主页、文章列表或搜索页。",
      confidence: 0.66,
      phase: "open_article",
      route: "wechat:exit_non_article",
      progressKey: "article:exit_non_article"
    };
  }

  if (facts.isWechatAccountHome) {
    const article = findLatestArticleEntry(screen, account);
    if (article?.bounds) {
      return {
        action: { type: "tap_element", elementId: article.id },
        description: `打开 ${account} 公众号最新文章。`,
        expectedResult: "进入文章阅读页。",
        confidence: Math.min(0.82, article.confidence),
        phase: "open_article",
        route: "wechat:account_home",
        progressKey: `article:open:${article.id}`
      };
    }
    return {
      action: { type: "collect_scroll", direction: "down", maxScrolls: 1 },
      description: `浏览 ${account} 公众号主页，寻找最新文章。`,
      expectedResult: "文章列表加载出来。",
      confidence: 0.58,
      phase: "open_article",
      route: "wechat:account_home_scroll",
      progressKey: "article:account_home_scroll"
    };
  }

  if (facts.isWechatContactsPage) {
    const officialAccounts = findWechatOfficialAccountsEntry(screen);
    if (officialAccounts?.bounds) {
      return {
        action: { type: "tap_element", elementId: officialAccounts.id },
        description: "从通讯录进入公众号列表。",
        expectedResult: "打开公众号列表。",
        confidence: Math.min(0.9, officialAccounts.confidence),
        phase: "locate_source",
        route: "wechat:contacts",
        guardReason: "公众号阅读阶段只找公众号入口，不处理联系人列表。",
        progressKey: "article:contacts:official_accounts"
      };
    }

    if (shouldSwitchRoute({ route: "wechat:contacts_top", noProgressCount: context.noProgressCount ?? 0 })) {
      return planWechatOfficialAccountSearch(intent, screen, facts, "通讯录入口没有继续变化，改用微信搜索查找公众号。");
    }

    return {
      action: { type: "collect_scroll", direction: "up", maxScrolls: 1 },
      description: "回到通讯录顶部快捷入口区查找公众号卡片。",
      expectedResult: "新的朋友、群聊、标签、公众号等快捷入口出现在列表顶部。",
      confidence: 0.56,
      phase: "locate_source",
      route: "wechat:contacts_top",
      progressKey: "article:contacts:scroll_top"
    };
  }

  if (facts.isWechatOfficialAccountsList) {
    const accountEntry = findWechatOfficialAccountEntry(screen, account);
    if (accountEntry?.bounds) {
      return {
        action: { type: "tap_element", elementId: accountEntry.id },
        description: `在公众号列表中打开 ${account}。`,
        expectedResult: `进入 ${account} 公众号主页。`,
        confidence: Math.min(0.9, accountEntry.confidence),
        phase: "locate_source",
        route: "wechat:official_accounts_list",
        progressKey: `article:account:${accountEntry.id}`
      };
    }

    const clippedAccount = findWechatClippedOfficialAccountEntry(screen, account);
    if (clippedAccount?.bounds && clippedAccount.bounds.y < 300) {
      return {
        action: { type: "collect_scroll", direction: "up", maxScrolls: 1 },
        description: `${account} 已在列表顶部边缘但被导航栏遮住，先轻微回滚让它完全露出。`,
        expectedResult: `${account} 出现在可点击区域。`,
        confidence: 0.7,
        phase: "locate_source",
        route: "wechat:official_accounts_list",
        progressKey: "article:official_list:reveal_top"
      };
    }

    if (facts.isWechatSearchScreen || screen.keyboardVisible) {
      return planWechatOfficialAccountSearch(intent, screen, facts, `公众号列表没有继续出现 ${account}，改用搜索查找。`);
    }

    return {
      action: { type: "collect_scroll", direction: "down", maxScrolls: 1 },
      description: "浏览公众号列表，寻找目标公众号。",
      expectedResult: "列表继续滚动并展示更多公众号。",
      confidence: 0.56,
      phase: "locate_source",
      route: "wechat:official_accounts_list",
      progressKey: "article:official_list:scroll"
    };
  }

  if (facts.isWechatSearchScreen || facts.isWechatGlobalSearchOrAiPage || facts.isWechatNoFriendSearchResults) {
    return planWechatOfficialAccountSearch(intent, screen, facts, "当前搜索页可服务公众号查找，直接搜索目标公众号。");
  }

  if (facts.isWechatMainPage || facts.isWechat) {
    const contactsTab = findWechatContactsTab(screen);
    if (contactsTab?.bounds) {
      return {
        action: { type: "tap_element", elementId: contactsTab.id },
        description: "优先切换到微信通讯录，准备从公众号入口进入。",
        expectedResult: "进入通讯录页面。",
        confidence: Math.min(0.86, contactsTab.confidence),
        phase: "locate_source",
        route: "wechat:contacts_preferred",
        progressKey: "article:open_contacts"
      };
    }

    const search = findWechatTopSearchEntry(screen) ?? findElement(screen, "搜索");
    if (search?.bounds) {
      return {
        action: { type: "tap_element", elementId: search.id },
        description: "没有稳定的通讯录入口，改用微信搜索查找公众号。",
        expectedResult: "进入搜索输入状态。",
        confidence: Math.min(0.76, search.confidence),
        phase: "locate_source",
        route: "wechat:search_official_account",
        progressKey: "article:open_search"
      };
    }

    return {
      action: backButton?.bounds ? { type: "tap_element", elementId: backButton.id } : { type: "back" },
      description: "从当前微信页面返回，寻找通讯录或搜索入口。",
      expectedResult: "回到微信首页或上层稳定页面。",
      confidence: 0.54,
      phase: "locate_source",
      route: "wechat:back_to_entry",
      progressKey: "article:back_to_entry"
    };
  }

  return openWechatDecision("打开微信，准备查找公众号。");
}

function planWechatOfficialAccountSearch(intent: ParsedIntent, screen: ScreenGraph, facts: ScreenFacts, reason: string): SkillDecision {
  const account = officialAccountName(intent);
  const accountEntry = findWechatOfficialAccountEntry(screen, account);
  if (accountEntry?.bounds) {
    return {
      action: { type: "tap_element", elementId: accountEntry.id },
      description: `打开搜索结果中的公众号 ${account}。`,
      expectedResult: `进入 ${account} 公众号主页。`,
      confidence: Math.min(0.86, accountEntry.confidence),
      phase: "locate_source",
      route: "wechat:search_official_account",
      guardReason: reason,
      progressKey: `article:search_result:${accountEntry.id}`
    };
  }

  if (facts.isWechatNoFriendSearchResults) {
    const cancel = findElement(screen, "取消");
    return {
      action: cancel?.bounds ? { type: "tap_element", elementId: cancel.id } : { type: "back" },
      description: "当前搜索结果停在无关分类且没有公众号结果，先退出搜索页再从公众号入口继续。",
      expectedResult: "回到微信首页、通讯录或公众号列表。",
      confidence: cancel?.bounds ? Math.min(0.76, cancel.confidence) : 0.58,
      phase: "locate_source",
      route: "wechat:contacts_official_accounts",
      guardReason: reason,
      progressKey: "article:search:no_result_exit"
    };
  }

  const existingQuery = facts.searchQuery;
  const clearButton = findWechatClearTextButton(screen);
  if (existingQuery && existingQuery !== account && clearButton?.bounds) {
    return {
      action: { type: "tap_element", elementId: clearButton.id },
      description: "清空微信搜索框，准备搜索目标公众号。",
      expectedResult: "搜索框变为空。",
      confidence: Math.min(0.82, clearButton.confidence),
      phase: "locate_source",
      route: "wechat:search_official_account",
      guardReason: reason,
      progressKey: "article:search:clear"
    };
  }

  if (existingQuery === account) {
    const submitSearch = findWechatSubmitSearchButton(screen);
    if (submitSearch?.bounds) {
      return {
        action: { type: "tap_element", elementId: submitSearch.id },
        description: `提交微信搜索 ${account}，等待公众号结果出现。`,
        expectedResult: "微信展示目标公众号搜索结果。",
        confidence: Math.min(0.76, submitSearch.confidence),
        phase: "locate_source",
        route: "wechat:search_official_account",
        guardReason: reason,
        progressKey: "article:search:submit"
      };
    }
    return {
      action: { type: "wait", ms: 900, reason: "等待公众号搜索结果加载。" },
      description: `等待 ${account} 的搜索结果加载。`,
      expectedResult: "搜索结果列表出现目标公众号。",
      confidence: 0.56,
      phase: "locate_source",
      route: "wechat:search_official_account",
      guardReason: reason,
      progressKey: "article:search:wait"
    };
  }

  const searchInput = findWechatSearchInput(screen);
  if (searchInput?.bounds && !screen.keyboardVisible) {
    return {
      action: { type: "tap_element", elementId: searchInput.id },
      description: "点击微信搜索输入框，准备输入公众号名称。",
      expectedResult: "搜索框获得焦点并弹出键盘。",
      confidence: Math.min(0.82, searchInput.confidence),
      phase: "locate_source",
      route: "wechat:search_official_account",
      guardReason: reason,
      progressKey: "article:search:focus"
    };
  }

  return {
    action: { type: "input", text: account },
    description: `在微信搜索框输入公众号 ${account}。`,
    expectedResult: "搜索结果中出现目标公众号。",
    confidence: 0.7,
    phase: "locate_source",
    route: "wechat:search_official_account",
    guardReason: reason,
    progressKey: `article:search:input:${account}`
  };
}

function planWechatMessage(intent: ParsedIntent, screen: ScreenGraph, facts: ScreenFacts, context: PlannerContext): SkillDecision {
  const contact = deliveryContactName(intent) ?? "";
  const message = intent.query ?? "晚上吃什么";
  if (!facts.isWechat) {
    return openWechatDecision("打开微信，准备发送消息。");
  }

  const webViewClose = findWechatWebViewCloseButton(screen);
  if (webViewClose?.bounds) {
    return {
      action: { type: "tap_element", elementId: webViewClose.id },
      description: "关闭当前公众号文章页，准备返回微信后查找联系人。",
      expectedResult: "退出文章 WebView，回到微信上一层页面。",
      confidence: Math.min(0.86, webViewClose.confidence),
      phase: "deliver_message",
      route: "wechat:exit_source",
      progressKey: "message:exit_source"
    };
  }

  if (facts.isWechatChatWithContact) {
    if (isWechatMessageSent(screen, message) && (!intent.freshSendRequired || isAutoGeneratedWechatSummary(message))) {
      return {
        action: { type: "finish", summary: `已向 ${contact} 发送消息。` },
        description: `确认消息已出现在 ${contact} 的聊天记录中。`,
        expectedResult: "任务完成。",
        confidence: 0.72,
        phase: "verify_done",
        route: "wechat:chat",
        progressKey: `message:sent:${contact}`
      };
    }

    const draftState = getWechatDraftState(screen, message);
    if (draftState === "duplicate" || draftState === "partial") {
      return {
        action: {
          type: "ask_user",
          prompt: draftState === "duplicate"
            ? "微信输入框里已经出现重复摘要草稿。我已停止继续输入，避免把内容越叠越多；请清空输入框后继续。"
            : "微信输入框里出现了不完整摘要草稿。我已停止继续输入，避免发送截断内容；请清空输入框后继续。"
        },
        description: draftState === "duplicate" ? "检测到重复草稿，停止继续输入。" : "检测到不完整草稿，停止继续输入。",
        expectedResult: "等待用户清空输入框或接管。",
        confidence: 0.82,
        phase: "deliver_message",
        route: "wechat:chat",
        guardReason: "发送前必须保证草稿完整且不是重复叠加。",
        progressKey: `message:draft:${draftState}`
      };
    }

    if (draftState === "exact") {
      const sendButton = findWechatSendButton(screen);
      if (sendButton?.bounds) {
        return {
          action: { type: "tap_element", elementId: sendButton.id },
          description: `点击发送，将消息发给 ${contact}。`,
          expectedResult: "消息发送出去，并出现在聊天记录中。",
          confidence: Math.min(0.9, sendButton.confidence),
          phase: "deliver_message",
          route: "wechat:chat",
          progressKey: `message:send:${contact}`
        };
      }
    }

    const chatInput = findWechatChatInput(screen, message);
    if (chatInput?.bounds && !screen.keyboardVisible) {
      return {
        action: { type: "tap_element", elementId: chatInput.id },
        description: "点击微信聊天输入框，准备输入消息。",
        expectedResult: "输入框获得焦点并弹出键盘。",
        confidence: Math.min(0.86, chatInput.confidence),
        phase: "deliver_message",
        route: "wechat:chat",
        progressKey: "message:focus_input"
      };
    }

    return {
      action: { type: "input", text: message },
      description: `准备给 ${contact} 输入消息草稿。`,
      expectedResult: "消息出现在输入框。",
      confidence: 0.68,
      phase: "deliver_message",
      route: "wechat:chat",
      progressKey: `message:input:${message}`
    };
  }

  const profileSendButton = findWechatProfileSendMessageButton(screen, contact);
  if (profileSendButton?.bounds) {
    return {
      action: { type: "tap_element", elementId: profileSendButton.id },
      description: `在 ${contact} 的朋友资料页点击发消息。`,
      expectedResult: `进入 ${contact} 的聊天页。`,
      confidence: Math.min(0.9, profileSendButton.confidence),
      phase: "deliver_message",
      route: "wechat:contact_profile",
      progressKey: `message:profile_send:${contact}`
    };
  }

  if ((facts.isWechatAccountHome || facts.isWechatOfficialAccountsList) && !facts.isWechatContactsPage && !isWechatRecentChatsPage(screen)) {
    const backButton = findElement(screen, "返回");
    return {
      action: backButton?.bounds ? { type: "tap_element", elementId: backButton.id } : { type: "back" },
      description: "已完成公众号阅读，先离开公众号页面；发送阶段不点击公众号页顶部搜索。",
      expectedResult: "回到微信上一层页面，再切到左下角微信近期聊天列表。",
      confidence: backButton?.bounds ? Math.min(0.78, backButton.confidence) : 0.56,
      phase: "deliver_message",
      route: "wechat:exit_source",
      progressKey: "message:exit_official_account"
    };
  }

  if (facts.isWechatSearchScreen || facts.isWechatResidualSearchResultsPage || facts.isWechatNoFriendSearchResults) {
    const contactResult = findWechatContactResult(screen, contact);
    if (contactResult?.bounds) {
      return {
        action: { type: "tap_element", elementId: contactResult.id },
        description: `点击微信搜索结果中已经出现的联系人 ${contact}。`,
        expectedResult: `打开 ${contact} 的聊天页。`,
        confidence: Math.min(0.9, contactResult.confidence),
        phase: "deliver_message",
        route: "wechat:search_contact_result",
        guardReason: "当前已经在搜索结果页，只消费现成结果，不继续输入或提交联系人搜索。",
        progressKey: `message:search_result:${contactResult.id}`
      };
    }

    return exitWechatSearchForRecentChats(screen, contact, "当前处在微信搜索页；发送阶段改回近期聊天列表找联系人，避免在搜索框里反复输入。");
  }

  const recentChat = isWechatRecentChatsPage(screen) ? findWechatRecentChatEntry(screen, contact) : undefined;
  if (recentChat?.bounds) {
    return {
      action: { type: "tap_element", elementId: recentChat.id },
      description: `在微信近期聊天列表中进入与 ${contact} 的聊天。`,
      expectedResult: `打开 ${contact} 的聊天页。`,
      confidence: Math.min(0.9, recentChat.confidence),
      phase: "deliver_message",
      route: "wechat:recent_chats",
      progressKey: `message:recent_chat:${recentChat.id}`
    };
  }

  if (facts.isWechat) {
    const chatsTab = findWechatChatsTab(screen);
    if (chatsTab?.bounds && !isWechatRecentChatsPage(screen)) {
      return {
        action: { type: "tap_element", elementId: chatsTab.id },
        description: "切到微信左下角“微信”页，从近期聊天列表查找联系人。",
        expectedResult: "进入微信近期聊天列表。",
        confidence: Math.min(0.84, chatsTab.confidence),
        phase: "deliver_message",
        route: "wechat:recent_chats",
        progressKey: "message:open_recent_chats"
      };
    }

    if (isWechatRecentChatsPage(screen)) {
      if (shouldSwitchRoute({ route: "wechat:recent_chats_scan", noProgressCount: context.noProgressCount ?? 0 })) {
        return {
          action: { type: "ask_user", prompt: `近期聊天列表里还没看到 ${contact}。我已停止自动搜索联系人，请你把与 ${contact} 的聊天露出来，或手动接管一次。` },
          description: `近期聊天列表没有定位到 ${contact}，不再改用搜索框。`,
          expectedResult: "等待用户接管或把目标聊天露出。",
          confidence: 0.56,
          phase: "deliver_message",
          route: "wechat:recent_chats",
          guardReason: "发送联系人不主动走微信搜索，避免未知搜索栏死循环。",
          progressKey: `message:recent_chat:not_found:${contact}`
        };
      }

      return {
        action: { type: "collect_scroll", direction: "down", maxScrolls: 1 },
        description: `在近期聊天列表继续下滑查找 ${contact}。`,
        expectedResult: "更多近期聊天露出，便于点击目标联系人。",
        confidence: 0.62,
        phase: "deliver_message",
        route: "wechat:recent_chats_scan",
        progressKey: `message:recent_chat:scroll:${contact}`
      };
    }

    const contactElement = findWechatStandaloneContactEntry(screen, contact);
    if (contactElement?.bounds && !hasWechatBottomTabBar(screenText(screen))) {
      return {
        action: { type: "tap_element", elementId: contactElement.id },
        description: `进入与 ${contact} 的聊天。`,
        expectedResult: `打开 ${contact} 的聊天页。`,
        confidence: Math.min(0.9, contactElement.confidence),
        phase: "deliver_message",
        route: "wechat:contacts",
        progressKey: `message:contact:${contactElement.id}`
      };
    }

    const backButton = findElement(screen, "返回");
    return {
      action: backButton?.bounds ? { type: "tap_element", elementId: backButton.id } : { type: "back" },
      description: "从当前微信页面返回，准备回到近期聊天列表。",
      expectedResult: "回到可切换到微信近期聊天的页面。",
      confidence: 0.54,
      phase: "deliver_message",
      route: "wechat:back_to_recent_chats",
      progressKey: "message:back_to_entry"
    };
  }

  return openWechatDecision("打开微信，准备发送消息。");
}

function planDianpingFoodSearch(intent: ParsedIntent, screen: ScreenGraph, facts: ScreenFacts): SkillDecision {
  const query = intent.query ?? intent.location ?? "附近美食";
  if (!facts.isTargetActive) {
    return {
      action: { type: "open_app", bundleId: "com.dianping.dpscope", displayName: "大众点评" },
      description: "打开大众点评，准备搜索美食信息。",
      expectedResult: "大众点评进入前台。",
      confidence: 0.86,
      phase: "open_app",
      route: "dianping:open_app",
      progressKey: "open_app:dianping"
    };
  }

  const text = screenText(screen);
  if (/人均|评分|地址|推荐|团购|榜单/.test(text)) {
    return {
      action: { type: "finish", summary: "已打开大众点评美食搜索结果，可根据店铺、评分、人均和位置生成推荐。" },
      description: "大众点评搜索结果已经出现。",
      expectedResult: "任务完成。",
      confidence: 0.86,
      phase: "verify_done",
      route: "dianping:results",
      progressKey: "finish:dianping_results"
    };
  }

  const existingQuery = findDianpingSearchQuery(screen);
  if (existingQuery && normalizeText(existingQuery).includes(normalizeText(query))) {
    const submit = findDianpingSubmitSearch(screen);
    return {
      action: submit?.bounds ? { type: "tap_element", elementId: submit.id } : { type: "wait", ms: 900, reason: "等待大众点评搜索结果加载。" },
      description: "提交大众点评搜索并等待结果。",
      expectedResult: "出现包含评分、人均、地址的店铺列表。",
      confidence: submit?.bounds ? Math.min(0.78, submit.confidence) : 0.58,
      phase: "locate_source",
      route: "dianping:submit_search",
      progressKey: "dianping:submit_search"
    };
  }

  const searchInput = findDianpingSearchInput(screen);
  if (searchInput?.bounds && !screen.keyboardVisible) {
    return {
      action: { type: "tap_element", elementId: searchInput.id },
      description: "点击大众点评搜索框。",
      expectedResult: "搜索框获得焦点并弹出键盘。",
      confidence: Math.min(0.84, searchInput.confidence),
      phase: "locate_source",
      route: "dianping:focus_search",
      progressKey: "dianping:focus_search"
    };
  }

  return {
    action: { type: "input", text: query },
    description: `在大众点评搜索框输入“${query}”。`,
    expectedResult: "大众点评展示对应的美食搜索结果。",
    confidence: 0.7,
    phase: "locate_source",
    route: "dianping:input_search",
    progressKey: `dianping:input:${query}`
  };
}

function exitWechatSearchForRecentChats(screen: ScreenGraph, contact: string, reason: string): SkillDecision {
  const cancel = findElement(screen, "取消");
  const backButton = findElement(screen, "返回");
  return {
    action: cancel?.bounds
      ? { type: "tap_element", elementId: cancel.id }
      : backButton?.bounds
        ? { type: "tap_element", elementId: backButton.id }
        : { type: "back" },
    description: `退出当前微信搜索页，改到左下角“微信”近期聊天列表找 ${contact}。`,
    expectedResult: "离开搜索输入状态，回到微信页面后可切到近期聊天列表。",
    confidence: cancel?.bounds ? Math.min(0.8, cancel.confidence) : backButton?.bounds ? Math.min(0.72, backButton.confidence) : 0.56,
    phase: "deliver_message",
    route: "wechat:exit_contact_search",
    guardReason: reason,
    progressKey: "message:search:exit_to_recent_chats"
  };
}

function openTargetAppDecision(intent: ParsedIntent, facts: ScreenFacts): PlannerOutput {
  if (intent.targetApp === "wechat") return resolveDecision(openWechatDecision("打开微信，准备继续任务。"));
  if (intent.targetApp === "dianping") {
    return resolveDecision({
      action: { type: "open_app", bundleId: "com.dianping.dpscope", displayName: "大众点评" },
      description: facts.isTargetActive ? "大众点评已经在前台。" : "打开大众点评，准备搜索地点和美食。",
      expectedResult: "大众点评进入前台。",
      confidence: 0.74,
      phase: "open_app",
      route: "dianping:open_app",
      progressKey: "open_app:dianping"
    });
  }
  return resolveDecision({
    action: { type: "ask_user", prompt: "我还不确定要打开哪个 App，请补充目标应用。" },
    description: "缺少目标 App。",
    expectedResult: "等待用户补充目标应用。",
    confidence: 0.42,
    phase: "open_app",
    route: "unknown:open_app",
    progressKey: "open_app:unknown"
  });
}

function openWechatDecision(description: string): SkillDecision {
  return {
    action: { type: "open_app", bundleId: "com.tencent.xin", displayName: "微信" },
    description,
    expectedResult: "微信进入前台。",
    confidence: 0.78,
    phase: "open_app",
    route: "wechat:open_app",
    progressKey: "open_app:wechat"
  };
}

function resolveDecision(decision: SkillDecision): PlannerOutput {
  return {
    action: decision.action,
    description: decision.description,
    expectedResult: decision.expectedResult,
    confidence: decision.confidence,
    phase: decision.phase,
    route: decision.route,
    guardReason: decision.guardReason,
    progressKey: decision.progressKey
  };
}

function shouldSwitchRoute(attempt: RouteAttempt): boolean {
  return attempt.noProgressCount >= 1;
}

function officialAccountName(intent: ParsedIntent): string {
  return intent.source?.name ?? intent.topic ?? "机器之心";
}

function deliveryContactName(intent: ParsedIntent): string | undefined {
  return intent.delivery?.name ?? intent.contact;
}

function minimalFallbackPlan(intent: ParsedIntent, screen: ScreenGraph): PlannerOutput {
  if (intent.targetApp && intent.targetApp !== "unknown") {
    if (isTargetAppActive(intent.targetApp, screen)) {
      const appName = intent.targetApp === "wechat" ? "WeChat" : "Dianping";
      return {
        action: { type: "finish", summary: `${appName} is already open.` },
        description: `${appName} is active in the foreground.`,
        expectedResult: "Task complete.",
        confidence: 0.9,
        phase: "verify_done",
        route: `${intent.targetApp}:active`,
        progressKey: `finish:${intent.targetApp}`
      };
    }
    return openTargetAppDecision(intent, buildScreenFacts(intent, screen));
  }

  return {
    action: {
      type: "ask_user",
      prompt: "The task needs a clearer app or next target. Please specify the app, source, query, or recipient."
    },
    description: "Request clearer task context.",
    expectedResult: "The user provides a more specific phone task.",
    confidence: 0.4,
    phase: "locate_source",
    route: "generic:minimal_fallback",
    progressKey: "ask:generic_context"
  };
}

function isTargetAppActive(targetApp: ParsedIntent["targetApp"], screen: ScreenGraph): boolean {
  if (targetApp === "wechat") return Boolean(screen.app?.includes("com.tencent.xin"));
  if (targetApp === "dianping") return Boolean(screen.app?.includes("com.dianping"));
  return false;
}

function findDianpingSearchInput(screen: ScreenGraph) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const bounds = node.bounds;
      const text = `${node.role ?? ""} ${node.label}`;
      return Boolean(
        bounds
        && bounds.y <= 420
        && bounds.width >= 260
        && /搜索|SearchField|TextField|商户|地点|菜品|想吃什么/.test(text)
      );
    })
    .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0))[0];
}

function findDianpingSearchQuery(screen: ScreenGraph): string | undefined {
  const input = findDianpingSearchInput(screen);
  const label = input?.label.trim();
  if (!label || /^搜索$|商户|地点|菜品|想吃什么/.test(label)) return undefined;
  return label;
}

function findDianpingSubmitSearch(screen: ScreenGraph) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => node.bounds && /^搜索$/.test(node.label.trim()) && node.bounds.y > 1200)
    .sort((a, b) => (b.bounds?.y ?? 0) - (a.bounds?.y ?? 0))[0];
}

function isWechatChatScreen(screen: ScreenGraph, contact: string): boolean {
  if (isWechatSearchScreen(screen)) return false;
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  if (/通讯录/.test(text) && /添加朋友|新的朋友|群聊|标签|公众号|企业微信联系人/.test(text)) return false;
  const hasContactTitle = labels.some((label) => label === contact || label.includes(contact));
  const hasChatInput = [...screen.nodes, ...screen.ocrBlocks].some((node) =>
    /XCUIElementTypeTextView|输入|发送|按住说话|语音/.test(`${node.role ?? ""} ${node.label}`)
  );
  return Boolean(screen.app?.includes("com.tencent.xin") || labels.includes("微信")) && hasContactTitle && hasChatInput;
}

function isWechatScreen(screen: ScreenGraph): boolean {
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  return Boolean(screen.app?.includes("com.tencent.xin") || labels.includes("微信"));
}

function screenText(screen: ScreenGraph): string {
  return [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label).join(" ");
}

function isWechatMainPage(screen: ScreenGraph): boolean {
  if (!isWechatScreen(screen) || isWechatSearchScreen(screen)) return false;
  const text = screenText(screen);
  return /微信/.test(text) && /通讯录/.test(text) && /发现/.test(text) && /我/.test(text);
}

function isWechatRecentChatsPage(screen: ScreenGraph): boolean {
  if (!isWechatScreen(screen) || isWechatSearchScreen(screen)) return false;
  const text = screenText(screen);
  const hasWechatTitle = [...screen.nodes, ...screen.ocrBlocks].some((node) =>
    node.label === "微信" && node.bounds && node.bounds.y < 420
  );
  if (!hasWechatBottomTabBar(text) || !hasWechatTitle) return false;
  return !isWechatContactsPage(screen) && !isWechatOfficialAccountsList(screen) && !isWechatAccountProfileSurface(text);
}

function isWechatContactsPage(screen: ScreenGraph): boolean {
  if (!isWechatScreen(screen)) return false;
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  const hasContactsTitle = [...screen.nodes, ...screen.ocrBlocks].some((node) => node.label === "通讯录" && node.bounds && node.bounds.y < 420);
  if (hasWechatBottomTabBar(text) && !hasContactsTitle) return false;
  if (/搜索本地|网络结果|最近在搜|问元宝|图片搜索|文件搜索|已选定,全部|大家都在搜|相关搜索/.test(text)) return false;
  if (isWechatAccountProfileSurface(text)) return false;
  return /通讯录/.test(text) && /新的朋友|群聊|标签|公众号|企业微信联系人/.test(text);
}

function isWechatOfficialAccountsList(screen: ScreenGraph): boolean {
  if (!isWechatScreen(screen)) return false;
  if (isWechatContactsPage(screen)) return false;
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  const hasOfficialAccountsTitle = [...screen.nodes, ...screen.ocrBlocks].some((node) => node.label === "公众号" && node.bounds && node.bounds.y < 420);
  if (hasWechatBottomTabBar(text) && !hasOfficialAccountsTitle) return false;
  if (isWechatAccountProfileSurface(text)) return false;
  return /公众号/.test(text) && /搜索|新的公众号|公众号列表|订阅号/.test(text) && !/账号描述|内容由AI生成|问 AI/.test(text);
}

function isWechatDraftVisible(screen: ScreenGraph, message: string): boolean {
  return getWechatDraftState(screen, message) === "exact";
}

function getWechatDraftState(screen: ScreenGraph, message: string): "empty" | "exact" | "duplicate" | "partial" {
  const textViewValues = extractTextViewValues(screen);
  const normalizedMessage = normalizeText(message);
  if (textViewValues.length) {
    for (const value of textViewValues) {
      const normalizedValue = normalizeText(value);
      if (!normalizedValue || !normalizedMessage) continue;
      const occurrences = countOccurrences(normalizedValue, normalizedMessage);
      if (occurrences > 1) return "duplicate";
      if (normalizedValue === normalizedMessage || occurrences === 1) return "exact";
      if (isLikelyAbbreviatedInputValue(normalizedValue, normalizedMessage)) return "exact";
      const head = normalizedMessage.slice(0, Math.min(24, normalizedMessage.length));
      if (head.length >= 8 && normalizedValue.includes(head)) return "partial";
    }
    return "empty";
  }

  const hasDraft = [...screen.nodes, ...screen.ocrBlocks].some((node) => {
    const text = `${node.role ?? ""} ${node.label}`;
    return hasDraftSnippet(node.label, message) && /XCUIElementTypeTextView|输入/.test(text);
  });
  return hasDraft ? "exact" : "empty";
}

function isWechatMessageSent(screen: ScreenGraph, message: string): boolean {
  if (isWechatDraftVisible(screen, message)) return false;
  return [...screen.nodes, ...screen.ocrBlocks].some((node) =>
    /^(我[,，])/.test(node.label) && hasMessageSnippet(node.label, message)
  );
}

function isAutoGeneratedWechatSummary(message: string): boolean {
  const normalized = normalizeText(message);
  return normalized.includes("phone-agent自动整理") || normalized.startsWith("我读了");
}

function hasMessageSnippet(label: string, message: string): boolean {
  const normalizedLabel = normalizeText(label);
  const normalizedMessage = normalizeText(message);
  if (!normalizedMessage) return false;
  if (normalizedMessage.length <= 20) return normalizedLabel.includes(normalizedMessage);
  if (normalizedLabel.includes(normalizedMessage)) return true;
  const title = normalizedMessage.match(/《([^》]{4,})》/)?.[1];
  if (title) {
    const titleHead = title.slice(0, Math.min(18, title.length));
    if (
      titleHead.length >= 8
      && normalizedLabel.includes(titleHead)
      && (normalizedLabel.includes("phone-agent自动整理") || normalizedLabel.includes("自动整理"))
    ) {
      return true;
    }
  }
  const head = normalizedMessage.slice(0, 28);
  const tail = normalizedMessage.slice(-18);
  return normalizedLabel.includes(head) && normalizedLabel.includes(tail);
}

function hasDraftSnippet(label: string, message: string): boolean {
  if (hasMessageSnippet(label, message)) return true;
  const normalizedLabel = normalizeText(label);
  const normalizedMessage = normalizeText(message);
  if (normalizedMessage.length <= 20) return normalizedLabel.includes(normalizedMessage);
  const head = normalizedMessage.slice(0, 36);
  return normalizedLabel.length >= 80 && normalizedLabel.includes(head);
}

function extractTextViewValues(screen: ScreenGraph): string[] {
  const rawSource = screen.rawSource;
  if (!rawSource) return [];
  return [...rawSource.matchAll(/<XCUIElementTypeTextView\b[^>]*\bvalue="([^"]*)"/g)]
    .map((match) => decodeXmlAttribute(match[1]))
    .filter((value) => value.trim().length > 0);
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index < value.length) {
    const found = value.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, "");
}

function isLikelyAbbreviatedInputValue(value: string, expected: string): boolean {
  if (expected.length < 120 || value.length < 80) return false;
  const compactValue = value.replace(/[.。…]{2,}/g, "");
  const positions = [0, 0.25, 0.5, 0.75, 1];
  const anchors = positions
    .map((position) => {
      if (position === 1) return expected.slice(Math.max(0, expected.length - 24));
      const start = Math.floor(expected.length * position);
      return expected.slice(start, start + (position === 0 ? 28 : 18));
    })
    .filter((anchor) => anchor.length >= 8);
  const hits = anchors.filter((anchor) => compactValue.includes(anchor)).length;
  const hasHead = anchors[0] ? compactValue.includes(anchors[0]) : false;
  const tail = anchors[anchors.length - 1];
  const hasTail = tail ? compactValue.includes(tail) : false;
  return hits >= 4 || (hits >= 3 && hasHead && hasTail);
}

function findWechatSendButton(screen: ScreenGraph) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => node.label === "发送" && node.bounds)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
}

function findWechatProfileSendMessageButton(screen: ScreenGraph, contact: string) {
  if (!isWechatScreen(screen)) return undefined;
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  if (!text.includes(contact) || !/朋友资料|微信号|昵称|朋友圈/.test(text)) return undefined;
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => node.label.trim() === "发消息" && node.bounds)
    .sort((a, b) => (a.bounds?.y ?? Number.MAX_SAFE_INTEGER) - (b.bounds?.y ?? Number.MAX_SAFE_INTEGER))[0];
}

function findWechatWebViewCloseButton(screen: ScreenGraph) {
  if (!isWechatScreen(screen)) return undefined;
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  if (!/MMWebView|XCUIElementTypeWebView|阅读原文|机器之心发布|公众号/.test(text)) return undefined;
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => node.label === "关闭" && node.bounds)
    .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0))[0];
}

function findWechatTopSearchEntry(screen: ScreenGraph) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const bounds = node.bounds;
      return Boolean(bounds && /搜索/.test(node.label) && bounds.y >= 0 && bounds.y <= 900 && bounds.x >= 0);
    })
    .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0))[0];
}

function findWechatChatInput(screen: ScreenGraph, message: string) {
  const minY = screen.screenSize ? Math.min(screen.screenSize.height * 0.65, 1600) : 600;
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const text = `${node.role ?? ""} ${node.label}`;
      const bounds = node.bounds;
      return Boolean(
        bounds
        && /XCUIElementTypeTextView|输入/.test(text)
        && !node.label.includes(message)
        && bounds.width >= 180
        && bounds.y >= minY
      );
    })
    .sort((a, b) => {
      const ay = a.bounds?.y ?? 0;
      const by = b.bounds?.y ?? 0;
      return by - ay;
    })[0];
}

function isWechatSearchScreen(screen: ScreenGraph): boolean {
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  const hasSearchInput = [...screen.nodes, ...screen.ocrBlocks].some((node) => {
    const bounds = node.bounds;
    const nodeText = `${node.role ?? ""} ${node.label}`;
    return Boolean(bounds && bounds.y <= 420 && /搜索|XCUIElementTypeSearchField|XCUIElementTypeTextField|XCUIElementTypeTextView/.test(nodeText));
  });
  const hasSearchContext = /搜索本地|网络结果|最近在搜|问元宝|图片搜索|文件搜索/.test(text);
  return Boolean(screen.app?.includes("com.tencent.xin") || labels.includes("微信")) && hasSearchInput && (hasSearchContext || screen.keyboardVisible);
}

function isWechatNoFriendSearchResults(screen: ScreenGraph): boolean {
  if (!isWechatScreen(screen)) return false;
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  return /该朋友暂无相关结果|暂无.*相关结果/.test(text) && /搜索|取消|清除文本/.test(text);
}

function findWechatSearchInput(screen: ScreenGraph) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const text = `${node.role ?? ""} ${node.label}`;
      const bounds = node.bounds;
      return Boolean(
        bounds
        && /XCUIElementTypeSearchField|XCUIElementTypeTextField|XCUIElementTypeTextView|搜索/.test(text)
        && bounds.width >= 200
        && bounds.y >= 80
        && bounds.y <= 380
      );
    })
    .sort((a, b) => {
      const ay = a.bounds?.y ?? Number.MAX_SAFE_INTEGER;
      const by = b.bounds?.y ?? Number.MAX_SAFE_INTEGER;
      return ay - by;
    })[0];
}

function findWechatSearchQuery(screen: ScreenGraph): string | undefined {
  const input = [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const text = `${node.role ?? ""} ${node.label}`;
      const bounds = node.bounds;
      return Boolean(bounds && /XCUIElementTypeSearchField|XCUIElementTypeTextField|XCUIElementTypeTextView/.test(text) && bounds.width >= 200 && bounds.y >= 80 && bounds.y <= 380);
    })
    .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0))[0];
  const label = input?.label.trim();
  if (!label || /^XCUIElementType|搜索本地|搜索$/.test(label)) return undefined;
  return label;
}

function findWechatClearTextButton(screen: ScreenGraph) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => /清除文本|清空/.test(node.label) && node.bounds)
    .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0))[0];
}

function findWechatContactResult(screen: ScreenGraph, contact: string) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => node.label === contact && node.bounds && node.bounds.y > 360)
    .sort((a, b) => {
      const ay = a.bounds?.y ?? Number.MAX_SAFE_INTEGER;
      const by = b.bounds?.y ?? Number.MAX_SAFE_INTEGER;
      return ay - by;
    })[0];
}

function findWechatSubmitSearchButton(screen: ScreenGraph) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const bounds = node.bounds;
      return Boolean(bounds && node.label.trim() === "搜索" && bounds.y >= 1600);
    })
    .sort((a, b) => (b.bounds?.y ?? 0) - (a.bounds?.y ?? 0))[0];
}

function findWechatStandaloneContactEntry(screen: ScreenGraph, contact: string) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const bounds = node.bounds;
      const text = `${node.role ?? ""} ${node.label}`;
      return Boolean(
        bounds
        && node.label === contact
        && bounds.y > 320
        && !/XCUIElementTypeSearchField|XCUIElementTypeTextField|XCUIElementTypeTextView/.test(text)
      );
    })
    .sort((a, b) => (a.bounds?.y ?? Number.MAX_SAFE_INTEGER) - (b.bounds?.y ?? Number.MAX_SAFE_INTEGER))[0];
}

function findWechatRecentChatEntry(screen: ScreenGraph, contact: string) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const bounds = node.bounds;
      const text = `${node.role ?? ""} ${node.label}`;
      const label = node.label.trim();
      return Boolean(
        bounds
        && isProbablyVisibleOnScreen(screen, node)
        && label.includes(contact)
        && bounds.y >= 300
        && bounds.y < 1850
        && !/XCUIElementTypeSearchField|XCUIElementTypeTextField|XCUIElementTypeTextView/.test(text)
        && !/搜索|取消|返回|标签页栏/.test(label)
      );
    })
    .sort((a, b) => (a.bounds?.y ?? Number.MAX_SAFE_INTEGER) - (b.bounds?.y ?? Number.MAX_SAFE_INTEGER))[0];
}

function findWechatChatsTab(screen: ScreenGraph) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => node.label === "微信" && node.bounds && node.bounds.y >= 1800)
    .sort((a, b) => (b.bounds?.y ?? 0) - (a.bounds?.y ?? 0))[0];
}

function findWechatContactsTab(screen: ScreenGraph) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => node.label === "通讯录" && node.bounds && node.bounds.y >= 1800)
    .sort((a, b) => (b.bounds?.y ?? 0) - (a.bounds?.y ?? 0))[0];
}

function findWechatOfficialAccountsEntry(screen: ScreenGraph) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const label = node.label.trim();
      const bounds = node.bounds;
      return Boolean(
        bounds
        && isProbablyVisibleOnScreen(screen, node)
        && bounds.y >= 180
        && /公众号/.test(label)
        && !/新的公众号|公众号列表|账号描述|内容由AI生成|问 AI/.test(label)
      );
    })
    .sort((a, b) => {
      const ay = a.bounds?.y ?? Number.MAX_SAFE_INTEGER;
      const by = b.bounds?.y ?? Number.MAX_SAFE_INTEGER;
      return ay - by;
    })[0];
}

function findWechatOfficialAccountEntry(screen: ScreenGraph, account: string) {
  const pageText = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label).join(" ");
  if (hasWechatBottomTabBar(pageText)) return undefined;
  const searchScreen = isWechatSearchScreen(screen) || isWechatNoFriendSearchResults(screen) || isWechatResidualSearchResultsPage(screen);
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const label = node.label.trim();
      const roleText = `${node.role ?? ""} ${label}`;
      const bounds = node.bounds;
      return Boolean(
        bounds
        && isProbablyVisibleOnScreen(screen, node)
        && bounds.y >= 300
        && label.includes(account)
        && !/XCUIElementTypeSearchField|XCUIElementTypeTextField|XCUIElementTypeTextView/.test(roleText)
        && !/账号描述|篇原创|问 AI|内容由AI生成|朋友圈|暂无|相关结果|搜索|取消|返回/.test(label)
        && (!searchScreen || (bounds.y > 330 && hasNearbyOfficialAccountContext(screen, node)))
      );
    })
    .sort((a, b) => (a.bounds?.y ?? Number.MAX_SAFE_INTEGER) - (b.bounds?.y ?? Number.MAX_SAFE_INTEGER))[0];
}

function findWechatClippedOfficialAccountEntry(screen: ScreenGraph, account: string) {
  return [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const label = node.label.trim();
      const roleText = `${node.role ?? ""} ${label}`;
      const bounds = node.bounds;
      return Boolean(
        bounds
        && bounds.y >= 0
        && bounds.y < 300
        && label.includes(account)
        && !/XCUIElementTypeSearchField|XCUIElementTypeTextField|XCUIElementTypeTextView/.test(roleText)
        && !/账号描述|篇原创|问 AI|内容由AI生成|朋友圈|暂无|相关结果|搜索|取消|返回/.test(label)
      );
    })
    .sort((a, b) => (b.bounds?.y ?? 0) - (a.bounds?.y ?? 0))[0];
}

function hasNearbyOfficialAccountContext(screen: ScreenGraph, target: ElementRef): boolean {
  const targetY = target.bounds?.y ?? 0;
  const nearbyText = [...screen.nodes, ...screen.ocrBlocks]
    .filter((node) => {
      const bounds = node.bounds;
      return bounds && Math.abs(bounds.y - targetY) < 260;
    })
    .map((node) => node.label)
    .join(" ");
  return /公众号|已关注|原创内容|专业的人工智能媒体|认证|账号|视频号/.test(nearbyText);
}

function isWechatArticleScreen(screen: ScreenGraph, account: string): boolean {
  return detectWechatArticleSurface(screen, account, false).ok;
}

function isWechatAccountHome(screen: ScreenGraph, account: string): boolean {
  if (!isWechatScreen(screen) || isWechatSearchScreen(screen)) return false;
  if (isLikelyWechatVideoFeed(screen)) return false;
  if (isWechatOfficialAccountsList(screen)) return false;
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  return labels.some((label) => label.includes(account))
    && (/发消息|私信|关注|服务|商品橱窗|视频号|全部\s*文章\s*视频号/.test(text) || isWechatAccountProfileSurface(text));
}

function findLatestArticleEntry(screen: ScreenGraph, account: string) {
  const blocked = /发消息|关注|公众号|服务|视频|直播|搜索|返回|更多|消息|菜单|赞|在看|留言|分享|播放|弹幕|预约|喜欢|评论|轻触重试|专业的人工智能媒体|篇原创内容|北京|朝阳|商品橱窗|全部预告|CreateAI|Create\d*|开发者大会|微信扫码|视频号直播|直播预约|数据引擎|决胜局|AI开源项目|AI研究前沿|私信|不再关注|已关注/;
  const elements = [...screen.nodes, ...screen.ocrBlocks];
  const articleGroupStartY = elements
    .filter((node) => node.bounds && /^(今天|昨天|前天)$/.test(node.label.trim()))
    .map((node) => node.bounds!.y)
    .sort((a, b) => a - b)[0];

  return elements
    .filter((node) => {
      const bounds = node.bounds;
      const label = node.label.trim();
      return Boolean(
        bounds
        && isProbablyVisibleOnScreen(screen, node)
        && bounds.width >= 120
        && bounds.y > 360
        && (articleGroupStartY === undefined || bounds.y >= articleGroupStartY)
        && label.length >= 8
        && !label.includes(account)
        && !/^(\d+\.|主要|已选定|账号|小店|划线|我的互动)/.test(label)
        && !blocked.test(label)
      );
    })
    .sort((a, b) => {
      const ay = a.bounds?.y ?? Number.MAX_SAFE_INTEGER;
      const by = b.bounds?.y ?? Number.MAX_SAFE_INTEGER;
      return ay - by;
    })[0];
}

function isProbablyVisibleOnScreen(screen: ScreenGraph, node: { bounds?: { x: number; y: number; width: number; height: number }; clickable?: boolean }): boolean {
  const bounds = node.bounds;
  if (!bounds) return false;
  if (node.clickable === false) return false;
  const viewport = screen.screenSize;
  if (!viewport) return bounds.y + bounds.height > 0;

  const visibleWidth = Math.min(bounds.x + bounds.width, viewport.width) - Math.max(bounds.x, 0);
  const visibleHeight = Math.min(bounds.y + bounds.height, viewport.height) - Math.max(bounds.y, 0);
  return visibleWidth > 12 && visibleHeight > 12;
}

function isWechatAccountProfileSurface(text: string): boolean {
  return /私信|不再关注|已关注公众号|篇原创内容|商品橱窗|视频号:|全部预告|账号描述/.test(text);
}

function isWechatLivePreviewPage(screen: ScreenGraph): boolean {
  if (!isWechatScreen(screen)) return false;
  const text = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label).join(" ");
  if (isWechatAccountProfileSurface(text)) return false;
  return /视频号直播|微信扫码预约|分享给朋友|预约/.test(text)
    && /直播|预告|开发者大会|Create/.test(text)
    && !/阅读原文|写留言|喜欢作者|在看/.test(text);
}

function isLikelyWechatVideoFeed(screen: ScreenGraph): boolean {
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  const hasSearchCategoryTabs = labels.some((label) => /文章,按钮|已选定,文章/.test(label))
    && labels.some((label) => /账号,按钮|小店,按钮|视频,按钮/.test(label));
  if (hasSearchCategoryTabs) return false;
  return /WCFinder|弹幕|播放|轻触重试|推荐给朋友/.test(text)
    || labels.some((label) => /^喜欢[:：]\d+|^评论\d+|^赞过\d+|^分享\d+/.test(label));
}

function isLikelyWechatAiSearchPage(text: string): boolean {
  return /内容由AI生成|问 AI|继续提问|切换模型|AI搜索/.test(text);
}

function isWechatGlobalSearchOrAiPage(screen: ScreenGraph): boolean {
  if (!isWechatScreen(screen)) return false;
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  return isWechatSearchScreen(screen) || isLikelyWechatAiSearchPage(text) || /已选定,全部,按钮|大家都在搜|相关搜索/.test(text);
}

function isWechatResidualSearchResultsPage(screen: ScreenGraph): boolean {
  if (!isWechatScreen(screen)) return false;
  const labels = [...screen.nodes, ...screen.ocrBlocks].map((node) => node.label);
  const text = labels.join(" ");
  return isLikelyWechatAiSearchPage(text) || /已选定,文章,按钮|已选定,全部,按钮|账号,按钮,21之|大家都在搜|相关搜索/.test(text);
}

function isLikelyWechatChatConversation(labels: string[], text: string): boolean {
  if (hasWechatBottomTabBar(text)) return false;
  const chatTranscriptLines = labels.filter(isLikelyChatTranscriptLine).length;
  const hasChatComposer = /语音输入|按住说话|表情|发送/.test(text) && /XCUIElementTypeTextView|输入框|更多/.test(text);
  return chatTranscriptLines >= 2 || hasChatComposer;
}

function hasWechatBottomTabBar(text: string): boolean {
  return /标签页栏/.test(text) && /微信/.test(text) && /通讯录/.test(text) && /发现/.test(text) && /我/.test(text);
}

function isLikelyChatTranscriptLine(label: string): boolean {
  return /^(我|你|对方|微信用户)[，,]\s*/.test(label) || /^\d{1,2}:\d{2}$/.test(label);
}

export function plannerSystemPrompt(): string {
  return [
    "你是 phone-agent 的手机 GUI 规划器。",
    "你只能返回 JSON，不要返回 Markdown。",
    "你必须一次只规划一个最小动作。",
    "优先使用 tap_element 或 tap_text，只有没有语义元素时才用 tap_xy。",
    "涉及支付、转账、删除、改账号、公开发布、陌生对象发送时，用 ask_user。",
    "允许的 action type: tap_element, tap_text, tap_xy, swipe, input, open_app, open_url, back, home, wait, collect_scroll, ask_user, finish。",
    "返回格式: {\"action\": {...}, \"description\": \"...\", \"expectedResult\": \"...\", \"confidence\": 0.0到1.0 }"
  ].join("\n");
}

export function plannerUserPrompt(intent: ParsedIntent, screen: ScreenGraph): string {
  const elements = [...screen.nodes, ...screen.ocrBlocks]
    .slice(0, 80)
    .map((element) => ({
      id: element.id,
      label: element.label,
      role: element.role,
      bounds: element.bounds,
      confidence: element.confidence
    }));

  return JSON.stringify({
    task: intent,
    screen: {
      app: screen.app,
      orientation: screen.orientation,
      keyboardVisible: screen.keyboardVisible,
      dialogs: screen.dialogs.map((dialog) => ({ id: dialog.id, label: dialog.label })),
      elements
    }
  });
}
