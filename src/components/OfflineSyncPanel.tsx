import {
  Accordion,
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  Paper,
  Radio,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { CloudUpload, History, WifiOff } from "lucide-react";
import { useState } from "react";
import {
  useMergeSyncBatchesMutation,
  useQueueOfflineOperationMutation,
} from "../services/api";
import type {
  EvidenceStrength,
  MergeConflict,
  MergeConflictResolution,
  NodeKind,
  RiskLevel,
  SyncBatch,
} from "../models/types";
import { SyncBatchStateBadge } from "./Badges";

interface OfflineSyncPanelProps {
  caseId: string;
  batches: SyncBatch[];
  nodeOptions: { value: string; label: string }[];
}

const investigators = ["林澜", "周明"];

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error && "error" in error) {
    return String(error.error);
  }
  return "操作失败，请稍后重试。";
};

const conflictList = (error: unknown): MergeConflict[] => {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof (error as { data?: unknown }).data === "object"
  ) {
    const data = (error as { data?: { conflicts?: unknown } }).data;
    if (Array.isArray(data?.conflicts)) {
      return data.conflicts as MergeConflict[];
    }
  }
  return [];
};

const opTypeLabel: Record<string, string> = {
  add_evidence: "离线登记证据",
  add_node: "离线加入节点",
  add_relation: "离线登记关系",
};

export function OfflineSyncPanel({
  caseId,
  batches,
  nodeOptions,
}: OfflineSyncPanelProps) {
  const [investigator, setInvestigator] = useState("周明");
  const [device, setDevice] = useState("离线终端 B-07");
  const [opKind, setOpKind] = useState<"add_evidence" | "add_node">(
    "add_evidence",
  );
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [evidenceForm, setEvidenceForm] = useState({
    title: "",
    source: "",
    strength: "medium" as EvidenceStrength,
    occurredAt: "2026-09-30T09:00",
    attachment: "",
    note: "",
  });
  const [nodeForm, setNodeForm] = useState({
    sourceId: "",
    label: "",
    kind: "account" as NodeKind,
    riskLevel: "medium" as RiskLevel,
    evidenceStrength: "medium" as EvidenceStrength,
    source: "",
    occurredAt: "2026-09-30T09:00",
    note: "",
    relationLabel: "",
    relationExplanation: "",
    amount: 0,
  });

  const [queueOperation, { isLoading: isQueuing }] =
    useQueueOfflineOperationMutation();
  const [mergeBatches, { isLoading: isMerging }] =
    useMergeSyncBatchesMutation();

  const [conflictContext, setConflictContext] = useState<{
    batchId: string;
    conflicts: MergeConflict[];
  } | null>(null);
  const [resolutions, setResolutions] = useState<
    Record<string, MergeConflictResolution>
  >({});

  const handleQueue = async () => {
    if (opKind === "add_evidence") {
      if (
        !evidenceForm.title.trim() ||
        !evidenceForm.source.trim() ||
        !evidenceForm.attachment.trim()
      ) {
        notifications.show({
          color: "red",
          title: "信息不完整",
          message: "离线证据名称、来源和附件标识均为必填项。",
        });
        return;
      }
      const result = await queueOperation({
        caseId,
        investigator,
        device,
        operation: {
          type: "add_evidence",
          payload: {
            ...evidenceForm,
            occurredAt: new Date(evidenceForm.occurredAt).toISOString(),
          } as unknown as Record<string, unknown>,
        },
      });
      if (result.error) {
        notifications.show({
          color: "red",
          title: "离线登记失败",
          message: errorMessage(result.error),
        });
        return;
      }
      notifications.show({
        color: "teal",
        title: "已加入离线批次",
        message: `调查员 ${investigator} 的操作已在本机保留，合并基线已固定。`,
      });
      setEvidenceForm((current) => ({
        ...current,
        title: "",
        source: "",
        attachment: "",
        note: "",
      }));
    } else {
      if (
        !nodeForm.sourceId ||
        !nodeForm.label.trim() ||
        !nodeForm.source.trim() ||
        !nodeForm.relationLabel.trim()
      ) {
        notifications.show({
          color: "red",
          title: "信息不完整",
          message: "关系源节点、节点名称、证据来源和关系名称均为必填项。",
        });
        return;
      }
      const result = await queueOperation({
        caseId,
        investigator,
        device,
        operation: {
          type: "add_node",
          payload: {
            ...nodeForm,
            amount: nodeForm.amount || undefined,
            occurredAt: new Date(nodeForm.occurredAt).toISOString(),
          } as unknown as Record<string, unknown>,
        },
      });
      if (result.error) {
        notifications.show({
          color: "red",
          title: "离线登记失败",
          message: errorMessage(result.error),
        });
        return;
      }
      notifications.show({
        color: "teal",
        title: "已加入离线批次",
        message: "节点与关系已离线保存，合并时不会覆盖主库已有线索。",
      });
      setNodeForm((current) => ({
        ...current,
        label: "",
        source: "",
        relationLabel: "",
        relationExplanation: "",
      }));
    }
  };

  const runMerge = async (
    batchId: string,
    nextResolutions?: Record<string, MergeConflictResolution>,
    failure?: boolean,
  ) => {
    const result = await mergeBatches({
      caseId,
      batchId,
      simulateFailure: failure ?? false,
      resolutions: nextResolutions,
    });
    if (result.error) {
      const conflicts = conflictList(result.error);
      const status = (result.error as { status?: string }).status;
      if (status === "CONFLICT" && conflicts.length > 0) {
        setConflictContext({ batchId, conflicts });
        setResolutions({});
        notifications.show({
          color: "orange",
          title: "发现离线冲突",
          message: "请按两名调查员各自的基线选择保留方式。",
        });
        return;
      }
      notifications.show({
        color: "red",
        title: "合并保存失败",
        message: errorMessage(result.error),
      });
      return;
    }
    const data = result.data;
    if (!data) {
      return;
    }
    notifications.show({
      color: "teal",
      title: "离线批次已合并",
      message: `新并入 ${data.appliedCount} 项，重复跳过 ${data.skippedDuplicateCount} 项。`,
    });
    setConflictContext(null);
    setResolutions({});
    setSimulateFailure(false);
  };

  const handleResolveAndMerge = () => {
    if (!conflictContext) {
      return;
    }
    if (Object.keys(resolutions).length < conflictContext.conflicts.length) {
      notifications.show({
        color: "red",
        title: "仍有冲突未决策",
        message: "每一项冲突都需要选择保留方式后才能合并。",
      });
      return;
    }
    void runMerge(conflictContext.batchId, resolutions);
  };

  return (
    <Paper>
      <Stack gap="md">
        <Alert color="blue" icon={<WifiOff size={16} />}>
          两名调查员离线修改同一案件时，各自批次按登记时的图谱/证据基线保存；
          合并只补缺项，冲突按双方基线列清后选择，任何一方都不会被静默覆盖。
        </Alert>

        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Select
            label="离线调查员"
            value={investigator}
            onChange={(value) => setInvestigator(value ?? "周明")}
            data={investigators.map((name) => ({ value: name, label: name }))}
          />
          <TextInput
            label="离线设备"
            value={device}
            onChange={(event) => setDevice(event.currentTarget.value)}
          />
          <Select
            label="离线操作类型"
            value={opKind}
            onChange={(value) =>
              setOpKind((value as "add_evidence" | "add_node") ?? "add_evidence")
            }
            data={[
              { value: "add_evidence", label: "离线登记证据" },
              { value: "add_node", label: "离线加入节点与关系" },
            ]}
          />
        </SimpleGrid>

        {opKind === "add_evidence" ? (
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label="证据名称"
              required
              value={evidenceForm.title}
              onChange={(event) =>
                setEvidenceForm((current) => ({
                  ...current,
                  title: event.currentTarget.value,
                }))
              }
            />
            <TextInput
              label="证据来源"
              required
              value={evidenceForm.source}
              onChange={(event) =>
                setEvidenceForm((current) => ({
                  ...current,
                  source: event.currentTarget.value,
                }))
              }
            />
            <Select
              label="证据强度"
              value={evidenceForm.strength}
              onChange={(value) =>
                setEvidenceForm((current) => ({
                  ...current,
                  strength: (value as EvidenceStrength) ?? "medium",
                }))
              }
              data={[
                { value: "strong", label: "强证据" },
                { value: "medium", label: "中等证据" },
                { value: "weak", label: "弱证据" },
              ]}
            />
            <TextInput
              type="datetime-local"
              label="证据发生时间"
              value={evidenceForm.occurredAt}
              onChange={(event) =>
                setEvidenceForm((current) => ({
                  ...current,
                  occurredAt: event.currentTarget.value,
                }))
              }
            />
            <TextInput
              label="附件标识"
              required
              value={evidenceForm.attachment}
              onChange={(event) =>
                setEvidenceForm((current) => ({
                  ...current,
                  attachment: event.currentTarget.value,
                }))
              }
            />
          </SimpleGrid>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label="关系源节点"
              required
              searchable
              value={nodeForm.sourceId}
              onChange={(value) =>
                setNodeForm((current) => ({
                  ...current,
                  sourceId: value ?? "",
                }))
              }
              data={nodeOptions}
            />
            <Select
              label="节点类型"
              value={nodeForm.kind}
              onChange={(value) =>
                setNodeForm((current) => ({
                  ...current,
                  kind: (value as NodeKind) ?? "account",
                }))
              }
              data={[
                { value: "account", label: "账户" },
                { value: "device", label: "设备" },
                { value: "ip", label: "IP 地址" },
                { value: "merchant", label: "商户" },
              ]}
            />
            <TextInput
              label="节点名称"
              required
              value={nodeForm.label}
              onChange={(event) =>
                setNodeForm((current) => ({
                  ...current,
                  label: event.currentTarget.value,
                }))
              }
            />
            <TextInput
              label="证据来源"
              required
              value={nodeForm.source}
              onChange={(event) =>
                setNodeForm((current) => ({
                  ...current,
                  source: event.currentTarget.value,
                }))
              }
            />
            <Select
              label="风险等级"
              value={nodeForm.riskLevel}
              onChange={(value) =>
                setNodeForm((current) => ({
                  ...current,
                  riskLevel: (value as RiskLevel) ?? "medium",
                }))
              }
              data={[
                { value: "high", label: "高风险" },
                { value: "medium", label: "中风险" },
                { value: "low", label: "低风险" },
              ]}
            />
            <Select
              label="证据强度"
              value={nodeForm.evidenceStrength}
              onChange={(value) =>
                setNodeForm((current) => ({
                  ...current,
                  evidenceStrength: (value as EvidenceStrength) ?? "medium",
                }))
              }
              data={[
                { value: "strong", label: "强" },
                { value: "medium", label: "中" },
                { value: "weak", label: "弱" },
              ]}
            />
            <TextInput
              type="datetime-local"
              label="证据发生时间"
              value={nodeForm.occurredAt}
              onChange={(event) =>
                setNodeForm((current) => ({
                  ...current,
                  occurredAt: event.currentTarget.value,
                }))
              }
            />
            <TextInput
              label="关联金额"
              value={String(nodeForm.amount)}
              onChange={(event) =>
                setNodeForm((current) => ({
                  ...current,
                  amount: Number(event.currentTarget.value) || 0,
                }))
              }
            />
            <TextInput
              label="关系名称"
              required
              value={nodeForm.relationLabel}
              onChange={(event) =>
                setNodeForm((current) => ({
                  ...current,
                  relationLabel: event.currentTarget.value,
                }))
              }
            />
            <TextInput
              label="关系解释"
              value={nodeForm.relationExplanation}
              onChange={(event) =>
                setNodeForm((current) => ({
                  ...current,
                  relationExplanation: event.currentTarget.value,
                }))
              }
            />
          </SimpleGrid>
        )}

        <Textarea
          label="说明"
          minRows={2}
          value={opKind === "add_evidence" ? evidenceForm.note : nodeForm.note}
          onChange={(event) =>
            opKind === "add_evidence"
              ? setEvidenceForm((current) => ({
                  ...current,
                  note: event.currentTarget.value,
                }))
              : setNodeForm((current) => ({
                  ...current,
                  note: event.currentTarget.value,
                }))
          }
        />

        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            同一调查员的离线操作会进入同一批次；批次基线在首次登记时固定。
          </Text>
          <Group>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={simulateFailure}
                onChange={(event) =>
                  setSimulateFailure(event.currentTarget.checked)
                }
              />
              <Text size="xs">模拟下次合并保存失败</Text>
            </label>
            <Button
              leftSection={<WifiOff size={16} />}
              loading={isQueuing}
              onClick={handleQueue}
            >
              加入离线批次
            </Button>
          </Group>
        </Group>
      </Stack>

      <Divider my="md" />

      {batches.length === 0 ? (
        <Text size="sm" c="dimmed" ta="center" py="md">
          暂无离线批次。两名调查员可分别在上方选择自己的身份登记离线操作。
        </Text>
      ) : (
        <Accordion
          variant="separated"
          multiple
          defaultValue={batches.map((batch) => batch.id)}
        >
          {batches.map((batch) => (
            <Accordion.Item key={batch.id} value={batch.id}>
              <Accordion.Control>
                <Group gap="sm">
                  <Text size="sm" fw={600}>
                    {batch.investigator} · {batch.device}
                  </Text>
                  <SyncBatchStateBadge value={batch.state} />
                  <Badge variant="light" color="gray">
                    {batch.operations.length} 项操作
                  </Badge>
                  {batch.state === "merged" ? (
                    <Badge variant="light" color="teal">
                      已并入 {batch.appliedOpIds.length} 项
                    </Badge>
                  ) : null}
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack gap="sm">
                  <Paper withBorder bg="var(--mantine-color-gray-0)" p="sm">
                    <Text size="xs" fw={600}>
                      批次基线（离线首个操作登记时固化）
                    </Text>
                    <Text size="xs" c="dimmed" mt={4}>
                      {batch.baseline.nodeCount} 节点 /{" "}
                      {batch.baseline.edgeCount} 关系 /{" "}
                      {batch.baseline.evidenceCount} 证据 · 时间线{" "}
                      <span style={{ fontFamily: "monospace" }}>
                        {batch.baseline.timelineVersion}
                      </span>
                    </Text>
                  </Paper>
                  <Table.ScrollContainer minWidth={520}>
                    <Table>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>操作</Table.Th>
                          <Table.Th>内容</Table.Th>
                          <Table.Th>登记时间</Table.Th>
                          <Table.Th>合并状态</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {batch.operations.map((op) => {
                          const payload = op.payload as unknown as {
                            title?: string;
                            label?: string;
                            relationLabel?: string;
                          };
                          const applied = batch.appliedOpIds.includes(op.id);
                          return (
                            <Table.Tr key={op.id}>
                              <Table.Td>
                                <Text size="xs">{opTypeLabel[op.type]}</Text>
                              </Table.Td>
                              <Table.Td>
                                <Text size="xs" fw={600}>
                                  {payload.title ||
                                    `${payload.label}（${payload.relationLabel}）`}
                                </Text>
                              </Table.Td>
                              <Table.Td>
                                <Text size="xs" c="dimmed">
                                  {new Date(op.createdAt).toLocaleString(
                                    "zh-CN",
                                    { hour12: false },
                                  )}
                                </Text>
                              </Table.Td>
                              <Table.Td>
                                {applied ? (
                                  <Badge size="xs" color="teal">
                                    已并入
                                  </Badge>
                                ) : (
                                  <Badge size="xs" color="gray">
                                    未并入
                                  </Badge>
                                )}
                              </Table.Td>
                            </Table.Tr>
                          );
                        })}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                  {batch.lastError ? (
                    <Alert color="red" title="上次保存失败">
                      {batch.lastError}
                    </Alert>
                  ) : null}
                  <Group justify="flex-end">
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={
                        batch.state === "merged" ? (
                          <History size={14} />
                        ) : (
                          <CloudUpload size={14} />
                        )
                      }
                      loading={isMerging}
                      onClick={() =>
                        void runMerge(
                          batch.id,
                          undefined,
                          batch.state === "save_failed"
                            ? false
                            : simulateFailure,
                        )
                      }
                    >
                      {batch.state === "merged"
                        ? "再次合并（只补缺项）"
                        : batch.state === "save_failed"
                          ? "重试合并"
                          : "合并到主库"}
                    </Button>
                  </Group>
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      )}

      <Modal
        opened={conflictContext !== null}
        onClose={() => setConflictContext(null)}
        title="离线合并冲突（按各自基线）"
        size="xl"
      >
        <Stack gap="lg">
          <Alert color="orange">
            双方修改基于不同基线，系统不会自动覆盖任何一方。请逐项选择保留方式：
          </Alert>
          {conflictContext?.conflicts.map((conflict, index) => (
            <Paper key={conflict.key} withBorder p="md">
              <Text fw={600}>
                {index + 1}. {conflict.label}
              </Text>
              <SimpleGrid cols={2} mt="sm">
                <Paper withBorder p="sm" bg="var(--mantine-color-blue-0)">
                  <Text size="xs" fw={700}>
                    本端 · {conflict.local.investigator}（
                    {conflict.local.device ?? "离线设备"}）
                  </Text>
                  <Text size="xs" mt={4}>
                    {conflict.local.summary}
                  </Text>
                  <Text size="xs" c="dimmed" mt={6}>
                    {conflict.localBaselineSummary}
                  </Text>
                </Paper>
                <Paper withBorder p="sm" bg="var(--mantine-color-orange-0)">
                  <Text size="xs" fw={700}>
                    对方 · {conflict.remote.investigator}
                  </Text>
                  <Text size="xs" mt={4}>
                    {conflict.remote.summary}
                  </Text>
                  <Text size="xs" c="dimmed" mt={6}>
                    {conflict.remoteBaselineSummary}
                  </Text>
                </Paper>
              </SimpleGrid>
              <Radio.Group
                mt="sm"
                value={resolutions[conflict.key] ?? ""}
                onChange={(value) =>
                  setResolutions((current) => ({
                    ...current,
                    [conflict.key]: value as MergeConflictResolution,
                  }))
                }
              >
                <Group>
                  <Radio value="keep_remote" label="采用对方版本（本端跳过）" />
                  <Radio
                    value="keep_local"
                    label="采用本端版本（不覆盖对方已有数据）"
                  />
                  <Radio
                    value="keep_both"
                    label="双方并存（本端自动加副本标识）"
                  />
                </Group>
              </Radio.Group>
            </Paper>
          ))}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConflictContext(null)}>
              取消
            </Button>
            <Button onClick={handleResolveAndMerge}>按选择合并</Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
