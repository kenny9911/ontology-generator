# 业务流程标准作业程序 (SOP) —— 外包招聘全流程 (RAAS)
## 从招聘需求受理到候选人入职与服务费结算

**文档编号:** RAAS-SOP-001
**版本:** 3.1
**归属部门:** 交付运营中心 (Delivery Operations Center, DOC)
**生效日期:** 2026-01-01
**复审周期:** 每半年
**适用范围:** 所有签署《招聘外包服务合同》(`ServiceContract`) 的客户企业 (`ClientCompany`) 的中高端及批量招聘项目。
**关联文档:** `02-业务规则与制度.md` (RAAS-POL-002)、`03-系统与数据实体.md` (RAAS-SYS-003)、`04-事件与工作流编排.md` (RAAS-EVT-004)。

---

## 1. 目的与范围

本 SOP 定义"招聘即服务 (RAAS)"端到端标准作业程序: 从客户企业提出招聘需求 (`RecruitmentRequest`) 开始, 经岗位对齐、JD (`JobDescription`) 生成、渠道发布与简历采集、简历解析与匹配打分、初筛与电话沟通、面试邀约与协调、面试评估与反馈、生成候选人推荐包 (`RecommendationPackage`) 交付客户、客户复试反馈、薪资谈判 (`SalaryNegotiation`)、发放 Offer (`Offer`) 与背调 (`BackgroundCheck`)、候选人接受或拒绝, 直至入职 (`OnboardingTicket`)、试用期与服务费 (`ServiceFee`) 回款结算。

本文档为每一步骤明确标注: 负责的【角色 / 系统】、涉及的【业务对象 (对象)】、执行的【系统动作 (动作)】(消费什么 / 产出什么)、触发或产生的【事件 (事件)】。文档覆盖正常路径与异常 / 例外路径。

本流程涉及【外包方 (我司)】与【客户企业】两方协作, 受服务级别协议 (SLA)、保证期 (`GuaranteePeriod`) 与回款里程碑约束, 详见 `02-业务规则与制度.md`。

权威记录系统 (System of Record):
- **TalentFlow ATS** —— 招聘需求、JD、候选人、简历、申请、面试、评估报告、推荐包、Offer 的主记录系统。
- **MatchEngine** —— 简历解析与匹配评分服务。
- **ClientPortal** —— 客户协作门户 (推荐包查看、面试反馈、Offer 审批)。
- **VerifyHub** —— 背景调查服务。
- **ContractBilling** —— 服务合同、服务费、回款里程碑、保证期结算系统。
- **CommChannel** —— 短信 / 邮件 / 电话外呼通知网关。

本流程分解为六个子流程 (流程):
- **P1 —— 需求受理与对齐 (Request Intake & Alignment)**
- **P2 —— JD 生成与渠道发布 (JD Authoring & Channel Posting)**
- **P3 —— 简历采集、解析与匹配 (Sourcing, Parsing & Matching)**
- **P4 —— 初筛、面试与评估 (Screening, Interview & Assessment)**
- **P5 —— 推荐、谈薪与录用 (Recommendation, Negotiation & Offer)**
- **P6 —— 入职与服务费结算 (Onboarding & Billing)**

---

## 2. 角色与系统 (执行者 Actors)

| 角色 / 系统 | 职责 |
|---|---|
| 招聘顾问 (Recruitment Consultant) | 项目主责人; 受理需求、采集简历、初筛、协调面试、组装推荐包、主导谈薪。 |
| 交付经理 (Delivery Manager) | 监控项目 SLA、审批高价值 Offer 与超预算薪资、处理升级。 |
| 寻源专员 (Sourcing Specialist) | 在招聘渠道 (`SourcingChannel`) 发布 JD 并主动寻访被动候选人。 |
| 客户对接人 (Client Contact) | 客户企业一方的 HR 或用人经理, 确认需求、查看推荐包、给出面试反馈。 |
| 客户面试官 (Client Interviewer) | 客户企业一方的面试官, 参与面试 (`Interview`) 并提交评估报告 (`AssessmentReport`)。 |
| 薪酬顾问 (Compensation Advisor) | 在谈薪环节校验期望薪资与客户预算区间, 计算服务费。 |
| 背调专员 (Screening Officer) | 在 VerifyHub 发起并跟踪背景调查 (`BackgroundCheck`)。 |
| 财务专员 (Finance Officer) | 在 ContractBilling 中确认回款里程碑、开具服务费发票、处理保证期返还。 |
| TalentFlow ATS | 需求、JD、候选人、简历、申请、面试、评估、推荐包、Offer 的记录系统。 |
| MatchEngine | 简历解析与匹配评分 (`MatchScore`) 服务。 |
| ClientPortal | 客户协作门户。 |
| VerifyHub | 背景调查服务。 |
| ContractBilling | 服务合同、服务费、回款里程碑与保证期系统。 |
| CommChannel | 通知外呼网关。 |

---

## 3. 流程步骤

### P1 —— 需求受理与对齐 (Request Intake & Alignment)

**步骤 1.1 —— 受理客户招聘需求。**
- **角色:** 招聘顾问; **系统:** TalentFlow ATS。
- **对象:** `ServiceContract` (服务合同)、`ClientCompany` (客户企业)、`RecruitmentRequest` (招聘需求)。
- **动作:** `CreateRecruitmentRequest` —— 消费客户对接人提交的岗位信息、用人画像、薪资范围, 以及关联的有效 `ServiceContract`; 产出一条状态为【待对齐 (Draft)】的 `RecruitmentRequest` 记录, 关联 `ClientCompany` 与负责的 `RecruitmentConsultant`。
- **触发事件:** `需求已提交 (RequestSubmitted)`。
- **产生事件:** `需求已创建 (RequestCreated)`。

**步骤 1.2 —— 需求对齐会议 (与客户对齐岗位、JD 要点、薪资范围、用人画像)。**
- **角色:** 招聘顾问、客户对接人。
- **对象:** `RecruitmentRequest`、`Position` (职位)、`SalaryBand` (薪资范围)。
- **动作:** `AlignRequirement` —— 消费 `RecruitmentRequest` 草稿与客户确认的岗位画像; 产出确认后的 `Position` 记录 (含职级、技能要求 `Skill` 列表、招聘人数 `headcount`、客户预算区间 `SalaryBand`), 并将 `RecruitmentRequest` 置为【已对齐 (Aligned)】。
- **触发事件:** `需求已创建 (RequestCreated)`。
- **产生事件:** `需求已对齐 (RequirementAligned)`。

**步骤 1.3 —— 校验服务合同与计费条款。**
- **角色:** 财务专员; **系统:** ContractBilling。
- **对象:** `ServiceContract`、`ServiceFee` (服务费)、`GuaranteePeriod` (保证期)。
- **动作:** `ValidateContractTerms` —— 消费 `ServiceContract` 中的服务费率 (按 Offer 年薪百分比)、回款里程碑定义、保证期天数; 产出绑定到本 `RecruitmentRequest` 的计费条款快照。若合同已逾期或额度不足, 阻断流程并退回客户对接人。
- **触发事件:** `需求已对齐 (RequirementAligned)`。
- **产生事件:** `合同条款已校验 (ContractTermsValidated)`。

*【异常 1.A】合同失效或欠费:* 若 `ServiceContract` 状态为【暂停 (Suspended)】或存在逾期未回款里程碑, 动作 `ValidateContractTerms` 产生事件 `项目已暂挂 (RequestOnHold)`, 由交付经理联系客户处理后方可继续。

---

### P2 —— JD 生成与渠道发布 (JD Authoring & Channel Posting)

**步骤 2.1 —— 生成 JD (职位描述)。**
- **角色:** 招聘顾问; **系统:** TalentFlow ATS。
- **对象:** `Position`、`JobDescription` (JD)、`Skill` (技能)。
- **动作:** `GenerateJobDescription` —— 消费已对齐的 `Position` 与技能要求列表; 产出一份状态为【待审 (PendingReview)】的 `JobDescription`, 含岗位职责、任职资格、薪资区间展示口径、地点。
- **触发事件:** `合同条款已校验 (ContractTermsValidated)`。
- **产生事件:** `JD已生成 (JobDescriptionDrafted)`。

**步骤 2.2 —— 客户审核并确认 JD。**
- **角色:** 客户对接人; **系统:** ClientPortal。
- **对象:** `JobDescription`。
- **动作:** `ApproveJobDescription` —— 消费【待审】JD 与客户在 ClientPortal 的批注; 产出状态为【已确认 (Approved)】或【需修改 (RevisionRequested)】的 `JobDescription`。
- **触发事件:** `JD已生成 (JobDescriptionDrafted)`。
- **产生事件:** `JD已确认 (JobDescriptionApproved)`。

*【例外 2.A】JD 需修改:* 若客户选择【需修改】, 产生事件 `JD需修订 (JobDescriptionRevisionRequested)`, 回到步骤 2.1; 修订往返次数受 SLA 约束 (见规则 R-08)。

**步骤 2.3 —— 多渠道发布 JD。**
- **角色:** 寻源专员; **系统:** TalentFlow ATS、SourcingChannel。
- **对象:** `JobDescription`、`SourcingChannel` (招聘渠道)、`JobPosting` (职位发布)。
- **动作:** `PublishToChannels` —— 消费【已确认】JD 与目标渠道清单 (招聘网站、社交平台、内部人才库); 为每个渠道产出一条 `JobPosting` 记录并置为【在线 (Live)】。
- **触发事件:** `JD已确认 (JobDescriptionApproved)`。
- **产生事件:** `JD已发布 (JobPostingPublished)`。

---

### P3 —— 简历采集、解析与匹配 (Sourcing, Parsing & Matching)

**步骤 3.1 —— 采集简历。**
- **角色:** 寻源专员 / 渠道回流; **系统:** TalentFlow ATS。
- **对象:** `JobPosting`、`Resume` (简历)、`Candidate` (候选人)、`Application` (申请)。
- **动作:** `IngestResume` —— 消费来自各 `SourcingChannel` 的投递简历文件; 产出 `Resume` 记录并创建或关联到 `Candidate`, 同时建立指向本 `Position` 的 `Application` (状态【新申请 (New)】)。
- **触发事件:** `JD已发布 (JobPostingPublished)` / `简历已投递 (ResumeReceived)`。
- **产生事件:** `简历已采集 (ResumeIngested)`。

**步骤 3.2 —— 简历解析与匹配打分。**
- **角色:** MatchEngine (系统)。
- **对象:** `Resume`、`Position`、`Skill`、`MatchScore` (匹配评分)。
- **动作:** `ParseAndScoreResume` —— 消费 `Resume` 文本与 `Position` 的技能 / 经验 / 学历要求; 产出结构化解析字段与一个 0–100 的 `MatchScore`, 写回 `Application`。
- **触发事件:** `简历已采集 (ResumeIngested)`。
- **产生事件:** `匹配评分已生成 (MatchScored)`。

**步骤 3.3 —— 候选池排序与筛选门槛。**
- **角色:** 招聘顾问; **系统:** TalentFlow ATS。
- **对象:** `Application`、`MatchScore`。
- **动作:** `FilterCandidatePool` —— 消费同一 `Position` 下所有 `Application` 的 `MatchScore`; 将分值 ≥ 70 的 `Application` 置为【待初筛 (ToScreen)】, 其余置为【不匹配 (NotMatched)】。
- **触发事件:** `匹配评分已生成 (MatchScored)`。
- **产生事件:** `候选池已筛选 (CandidatePoolFiltered)`。

---

### P4 —— 初筛、面试与评估 (Screening, Interview & Assessment)

**步骤 4.1 —— 电话初筛沟通。**
- **角色:** 招聘顾问; **系统:** TalentFlow ATS、CommChannel。
- **对象:** `Application`、`Candidate`、`ScreeningCall` (初筛记录)。
- **动作:** `ConductPhoneScreen` —— 消费【待初筛】`Application` 与候选人联系方式; 产出 `ScreeningCall` 记录 (含到岗时间、期望薪资 `expectedSalary`、求职意向), 将 `Application` 置为【已初筛通过 (Screened)】或【初筛淘汰 (Rejected)】。
- **触发事件:** `候选池已筛选 (CandidatePoolFiltered)`。
- **产生事件:** `初筛已完成 (ScreeningCompleted)`。

**步骤 4.2 —— 邀约面试 (协调候选人与客户面试官)。**
- **角色:** 招聘顾问、客户对接人; **系统:** TalentFlow ATS、CommChannel。
- **对象:** `Application`、`Interview` (面试)、`ClientInterviewer` (客户面试官)。
- **动作:** `ScheduleInterview` —— 消费【已初筛通过】`Application`、候选人可面时间与客户面试官档期; 产出 `Interview` 记录 (含轮次 `round`、时间、面试官、形式) 并向双方发送邀约通知。
- **触发事件:** `初筛已完成 (ScreeningCompleted)`。
- **产生事件:** `面试已安排 (InterviewScheduled)`。

*【异常 4.A】候选人改期 / 爽约:* 若候选人未到, 动作 `ScheduleInterview` 重新进入并产生 `面试需改期 (InterviewRescheduleRequested)`; 同一候选人连续两次爽约则置为【流失 (Withdrawn)】。

**步骤 4.3 —— 进行面试并提交评估报告。**
- **角色:** 客户面试官; **系统:** ClientPortal。
- **对象:** `Interview`、`AssessmentReport` (评估报告)。
- **动作:** `SubmitAssessmentReport` —— 消费完成的 `Interview` 与面试官评分维度 (技能、文化匹配、综合建议); 产出一份 `AssessmentReport`, 含评级 (`Strong Hire` / `Hire` / `No Hire`) 与是否进入下一轮。
- **触发事件:** `面试已安排 (InterviewScheduled)` / 面试实际完成。
- **产生事件:** `评估已提交 (AssessmentSubmitted)`。

**步骤 4.4 —— 面试反馈汇总与决策。**
- **角色:** 招聘顾问; **系统:** TalentFlow ATS。
- **对象:** `AssessmentReport`、`Application`。
- **动作:** `ConsolidateFeedback` —— 消费某候选人本轮所有 `AssessmentReport`; 产出汇总结论, 将 `Application` 置为【进入下一轮 (NextRound)】、【拟推荐 (ToRecommend)】或【面试淘汰 (Rejected)】。
- **触发事件:** `评估已提交 (AssessmentSubmitted)`。
- **产生事件:** `面试反馈已汇总 (FeedbackConsolidated)`。

---

### P5 —— 推荐、谈薪与录用 (Recommendation, Negotiation & Offer)

**步骤 5.1 —— 生成候选人推荐包并交付客户。**
- **角色:** 招聘顾问; **系统:** TalentFlow ATS、ClientPortal。
- **对象:** `Application`、`RecommendationPackage` (推荐包)、`Resume`、`AssessmentReport`、`MatchScore`。
- **动作:** `AssembleRecommendationPackage` —— 消费【拟推荐】候选人的简历、匹配评分、初筛记录与评估报告; 产出一份 `RecommendationPackage` 并发布到 ClientPortal 供客户查看。
- **触发事件:** `面试反馈已汇总 (FeedbackConsolidated)`。
- **产生事件:** `推荐包已交付 (RecommendationDelivered)`。

**步骤 5.2 —— 客户复试反馈。**
- **角色:** 客户对接人 / 客户面试官; **系统:** ClientPortal。
- **对象:** `RecommendationPackage`、`AssessmentReport`。
- **动作:** `RecordClientFeedback` —— 消费 `RecommendationPackage` 与客户决定 (录用 / 复试 / 拒绝); 产出客户反馈记录。客户选择【复试】时, 回到步骤 4.2 安排额外面试轮次。
- **触发事件:** `推荐包已交付 (RecommendationDelivered)`。
- **产生事件:** `客户已决策 (ClientDecisionRecorded)`。

**步骤 5.3 —— 薪资谈判 (谈薪)。**
- **角色:** 招聘顾问、薪酬顾问; **系统:** TalentFlow ATS。
- **对象:** `SalaryNegotiation` (薪资谈判)、`Candidate`、`Position`、`SalaryBand`。
- **动作:** `NegotiateSalary` —— 消费候选人期望薪资 `expectedSalary`、客户预算区间 `SalaryBand` 与保证期要求; 产出一条 `SalaryNegotiation` 记录, 含拟定年薪 `proposedSalary`、入职日期、保证期天数。超出客户预算上限需升级审批 (见规则 R-21)。
- **触发事件:** `客户已决策 (ClientDecisionRecorded)` (录用方向)。
- **产生事件:** `薪资已达成 (SalaryAgreed)`。

**步骤 5.4 —— 客户审批并发放 Offer。**
- **角色:** 交付经理、客户对接人; **系统:** TalentFlow ATS、ClientPortal。
- **对象:** `SalaryNegotiation`、`Offer`、`ServiceFee`。
- **动作:** `IssueOffer` —— 消费已达成的 `SalaryNegotiation` 与客户在 ClientPortal 的批准; 产出一份 `Offer` 记录 (状态【已发出 (Issued)】), 同时在 ContractBilling 预登记对应 `ServiceFee` (按 `proposedSalary` × 服务费率)。
- **触发事件:** `薪资已达成 (SalaryAgreed)`。
- **产生事件:** `Offer已发出 (OfferIssued)`。

**步骤 5.5 —— 背景调查。**
- **角色:** 背调专员; **系统:** VerifyHub。
- **对象:** `Offer`、`BackgroundCheck` (背调)、`Candidate`。
- **动作:** `RunBackgroundCheck` —— 消费 `Offer` 与候选人授权; 在 VerifyHub 产出 `BackgroundCheck` 记录, 结果为【通过 (Clear)】或【异常 (Flagged)】。
- **触发事件:** `Offer已发出 (OfferIssued)`。
- **产生事件:** `背调已完成 (BackgroundCheckCleared)`。

*【异常 5.A】背调异常:* 若结果为【异常】, 产生 `背调异常 (BackgroundCheckFlagged)`, 由交付经理与客户复核; 重大不实信息按规则 R-26 撤回 Offer。

**步骤 5.6 —— 候选人接受或拒绝 Offer。**
- **角色:** 候选人 (经招聘顾问); **系统:** TalentFlow ATS、CommChannel。
- **对象:** `Offer`、`Candidate`。
- **动作:** `RecordOfferResponse` —— 消费候选人答复; 将 `Offer` 置为【已接受 (Accepted)】或【已拒绝 (Declined)】。
- **触发事件:** `背调已完成 (BackgroundCheckCleared)`。
- **产生事件:** `Offer已接受 (OfferAccepted)` 或 `Offer已拒绝 (OfferDeclined)`。

*【例外 5.B】Offer 被拒:* 产生 `Offer已拒绝 (OfferDeclined)`, 招聘顾问回到 P5 推荐备选候选人或回到 P3 补充候选池。

---

### P6 —— 入职与服务费结算 (Onboarding & Billing)

**步骤 6.1 —— 生成入职单并启动 onboarding。**
- **角色:** 招聘顾问、客户对接人; **系统:** TalentFlow ATS。
- **对象:** `Offer`、`OnboardingTicket` (入职单)、`Candidate`。
- **动作:** `CreateOnboardingTicket` —— 消费【已接受】`Offer`; 产出 `OnboardingTicket` (含入职材料清单、报到日期、试用期 `probationDays`), 移交客户 HR。
- **触发事件:** `Offer已接受 (OfferAccepted)`。
- **产生事件:** `入职单已创建 (OnboardingTicketCreated)`。

**步骤 6.2 —— 候选人到岗确认。**
- **角色:** 客户对接人; **系统:** ClientPortal。
- **对象:** `OnboardingTicket`、`Candidate`。
- **动作:** `ConfirmOnboarding` —— 消费候选人实际报到信息与入职材料齐备情况; 将 `OnboardingTicket` 置为【已入职 (Onboarded)】。
- **触发事件:** `入职单已创建 (OnboardingTicketCreated)`。
- **产生事件:** `候选人已入职 (CandidateOnboarded)`。

**步骤 6.3 —— 触发首期服务费回款里程碑。**
- **角色:** 财务专员; **系统:** ContractBilling。
- **对象:** `ServiceFee`、`ServiceContract`、`OnboardingTicket`。
- **动作:** `TriggerBillingMilestone` —— 消费【已入职】事件与预登记 `ServiceFee`; 产出首期回款里程碑 (入职即开票, 通常占服务费 70%, 见规则 R-30) 与对应发票。
- **触发事件:** `候选人已入职 (CandidateOnboarded)`。
- **产生事件:** `回款里程碑已触发 (BillingMilestoneTriggered)`。

**步骤 6.4 —— 保证期跟踪与尾款 / 返还结算。**
- **角色:** 财务专员、招聘顾问; **系统:** ContractBilling。
- **对象:** `GuaranteePeriod` (保证期)、`ServiceFee`、`OnboardingTicket`。
- **动作:** `SettleGuaranteePeriod` —— 消费 `OnboardingTicket` 在保证期内的在职状态; 保证期 (默认 90 天) 期满且候选人仍在职, 产出尾款里程碑 (剩余 30%) 并关闭项目。
- **触发事件:** `回款里程碑已触发 (BillingMilestoneTriggered)` + 保证期到期。
- **产生事件:** `服务费已结算 (ServiceFeeSettled)`。

*【异常 6.A】保证期内离职:* 若候选人在 `GuaranteePeriod` 内离职, 动作 `SettleGuaranteePeriod` 产生 `保证期内离职 (GuaranteeBreached)`; 按规则 R-31 触发免费替补 (回到 P3) 或按比例返还已收服务费。

---

## 4. SLA 与升级 (例外总览)

| 节点 | SLA 时限 | 超时升级对象 |
|---|---|---|
| 需求受理 → 首批推荐包交付 | 7 个工作日 | 交付经理 |
| 推荐包交付 → 客户反馈 | 3 个工作日 (客户侧 SLA) | 客户对接人 → 交付经理 |
| 面试安排 → 评估报告提交 | 2 个工作日 | 招聘顾问 |
| Offer 发出 → 候选人答复 | 5 个自然日 | 招聘顾问 → 交付经理 |
| 背调发起 → 背调完成 | 5 个工作日 | 背调专员 |

任意节点超时, 系统 (TalentFlow ATS) 产生 `SLA已超时 (SLABreached)` 事件并通知对应升级对象 (见 `04-事件与工作流编排.md` 的监控工作流)。
