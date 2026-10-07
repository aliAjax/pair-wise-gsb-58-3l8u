import {
  Accordion,
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  CloudUpload,
  GitMerge,
  WifiOff,
  XCircle,
} from "lucide-react";
import type { SyncBatch } from "../../models/types";
import { SyncBatchStateBadge } from "../../components/Badges";
import {
  useCreateSyncBatchMutation,
  useMergeSyncBatchMutation,
  useResolveSyncConflictMutation,
} from "../../services/api";

const kindLabel: Record<SyncBatch["changes"][number]["kind"], string> = {
  add_evidence: "登记证据",
  add_node: "加入节点",
  update_summary: "修改摘要",
  update_node_note: "更新节点说明",
};

interface OfflineSyncPanelProps {
  caseId: string;
  currentRevision: number;
  batches: SyncBatch[];
}

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error && "error" in error) {
    return String(error.error);
  }
  return "操作失败。";
};

export function OfflineSyncPanel({
  caseId,
  currentRevision,
  batches,
}: OfflineSyncPanelProps) {
  const [createBatch, { isLoading: isCreating }] =
    useCreateSyncBatchMutation();
  const [mergeBatchAction, { isLoading: isMerging }] =
    useMergeSyncBatchMutation();
  const [resolveConflict, { isLoading: isResolving }] =
    useResolveSyncConflictMutation();

  const createOfflineBatch = async (failNext: boolean) => {
    try {
      await createBatch({
        caseId,
        investigator: failNext ? "宋佳" : "周明",
        baseRevision: currentRevision,
        failNext,
        changes: [
          {
            kind: "add_evidence",
            actor: failNext ? "宋佳" : "周明",
            payload: {
              clientId: `offline-${failNext ? "song" : "zhou"}-${caseId}-${Date.now()}`,
              title: failNext
                ? "离线补录：付款用途情况说明"
                : "离线补录：柜面核身录像清单",
              source: failNext ? "企业客户回函" : "柜面影像系统",
              strength: "medium",
              occurredAt: new Date().toISOString(),
              attachment: failNext
                ? "payment-purpose-reply.pdf"
                : "counter-verify-list.xlsx",
              note: "该证据由调查员离线登记，合并时按业务键幂等去重。",
            },
          },
        ],
      }).unwrap();
      notifications.show({
        color: "teal",
        title: "离线批次已登记",
        message: failNext
          ? "批次将在首次合并时模拟保存失败，可验证失败保留与重试。"
          : "两名调查员的离线改动可各自基于当前版本登记，合并时不会互相覆盖。",
      });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "登记失败",
        message: errorMessage(error),
      });
    }
  };

  const handleMerge = async (batchId: string) => {
    try {
      const result = await mergeBatchAction({ batchId }).unwrap();
      notifications.show({
        color: "teal",
        title:
          result.batch.state === "merged"
            ? "批次已全部合并"
            : "合并完成，存在待裁决冲突",
        message:
          result.batch.state === "merged"
            ? `本次落库/补缺 ${result.appliedCount} 项，案件线索版本已推进。`
            : "无冲突项已落库，冲突项已按双方基线列清，请裁决后再次合并。",
      });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "保存失败，批次已保留",
        message: `${errorMessage(error)} 可直接点击重试，已落库项不会重复写入。`,
      });
    }
  };

  const handleResolve = async (
    batchId: string,
    changeId: string,
    resolution: "keep_server" | "apply_mine",
  ) => {
    try {
      await resolveConflict({ batchId, changeId, resolution }).unwrap();
      notifications.show({
        color: "teal",
        title: resolution === "keep_server" ? "已保留服务端版本" : "将采用离线版本",
        message:
          resolution === "keep_server"
            ? "该缺项在下次合并时跳过，不会覆盖对方改动。"
            : "裁决已记录，请再次执行合并使离线版本落库。",
      });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "裁决失败",
        message: errorMessage(error),
      });
    }
  };

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" align="flex-start">
        <Group gap="xs" align="flex-start">
          <ThemeIcon variant="light" color="blue">
            <WifiOff size={16} />
          </ThemeIcon>
          <div>
            <Text size="sm" fw={700}>
              离线调查批次
            </Text>
            <Text size="xs" c="dimmed" mt={3}>
              当前案件线索版本 R{currentRevision}；批次合并按基线列冲突、失败可重试、重复合并只补缺项。
            </Text>
          </div>
        </Group>
        <Group>
          <Button
            size="xs"
            variant="default"
            leftSection={<WifiOff size={14} />}
            loading={isCreating}
            onClick={() => createOfflineBatch(false)}
          >
            模拟调查员离线登记
          </Button>
          <Button
            size="xs"
            variant="light"
            color="orange"
            leftSection={<XCircle size={14} />}
            loading={isCreating}
            onClick={() => createOfflineBatch(true)}
          >
            模拟离线登记（下次保存失败）
          </Button>
        </Group>
      </Group>

      {batches.length === 0 ? (
        <Text size="xs" c="dimmed" mt="md">
          暂无离线批次。
        </Text>
      ) : (
        <Accordion variant="separated" mt="md" multiple defaultValue={batches.map((item) => item.id)}>
          {batches.map((batch) => (
            <Accordion.Item key={batch.id} value={batch.id}>
              <Accordion.Control>
                <Group gap="sm">
                  <Text size="sm" ff="monospace">
                    {batch.id}
                  </Text>
                  <SyncBatchStateBadge value={batch.state} />
                  <Badge variant="light" color="gray">
                    {batch.investigator} · 基线 R{batch.baseRevision}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {batch.appliedChangeIds.length}/{batch.changes.length} 项已处理
                  </Text>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack gap="sm">
                  {batch.lastError ? (
                    <Alert color="red" title="上次保存失败">
                      {batch.lastError}
                    </Alert>
                  ) : null}
                  {batch.changes.map((change) => {
                    const applied = batch.appliedChangeIds.includes(change.id);
                    const conflict = batch.conflicts.find(
                      (item) => item.changeId === change.id,
                    );
                    return (
                      <Paper
                        key={change.id}
                        withBorder
                        p="sm"
                        bg={applied ? "var(--mantine-color-teal-0)" : undefined}
                      >
                        <Group justify="space-between">
                          <Group gap="xs">
                            <Badge variant="outline" color="gray">
                              {kindLabel[change.kind]}
                            </Badge>
                            <Text size="sm" fw={600}>
                              {change.payload.title ??
                                change.payload.nodeLabel ??
                                "案件摘要修改"}
                            </Text>
                            {applied ? (
                              <Badge size="xs" color="teal">
                                已处理/已落库
                              </Badge>
                            ) : (
                              <Badge size="xs" color="blue">
                                待合并
                              </Badge>
                            )}
                          </Group>
                          <Text size="xs" c="dimmed">
                            {change.actor} · 基于 R{change.baseRevision}
                          </Text>
                        </Group>

                        {conflict ? (
                          <Alert color="orange" mt="sm" title={conflict.description}>
                            <Stack gap="xs">
                              <Group gap="xs" align="flex-start">
                                <Badge
                                  size="xs"
                                  variant="light"
                                  color="gray"
                                  mt={2}
                                >
                                  该调查员基线
                                </Badge>
                                <Text size="xs">{conflict.baseline}</Text>
                              </Group>
                              <Group gap="xs" align="flex-start">
                                <Badge
                                  size="xs"
                                  variant="light"
                                  color="teal"
                                  mt={2}
                                >
                                  服务端当前
                                </Badge>
                                <Text size="xs">{conflict.current}</Text>
                              </Group>
                              {conflict.resolution ? (
                                <Text size="xs" fw={600} c={conflict.resolution === "keep_server" ? "teal" : "orange"}>
                                  已裁决：
                                  {conflict.resolution === "keep_server"
                                    ? "保留服务端版本（下次合并跳过该项）"
                                    : "采用离线版本（下次合并强制落库）"}
                                </Text>
                              ) : (
                                <Group>
                                  <Button
                                    size="compact-xs"
                                    variant="light"
                                    color="teal"
                                    loading={isResolving}
                                    onClick={() =>
                                      handleResolve(
                                        batch.id,
                                        conflict.changeId,
                                        "keep_server",
                                      )
                                    }
                                  >
                                    保留服务端版本
                                  </Button>
                                  <Button
                                    size="compact-xs"
                                    variant="light"
                                    color="orange"
                                    loading={isResolving}
                                    onClick={() =>
                                      handleResolve(
                                        batch.id,
                                        conflict.changeId,
                                        "apply_mine",
                                      )
                                    }
                                  >
                                    采用我的离线版本
                                  </Button>
                                </Group>
                              )}
                            </Stack>
                          </Alert>
                        ) : null}
                      </Paper>
                    );
                  })}

                  <Group justify="flex-end">
                    <Button
                      size="xs"
                      leftSection={<GitMerge size={14} />}
                      loading={isMerging}
                      disabled={
                        batch.state === "merged" &&
                        batch.appliedChangeIds.length === batch.changes.length
                      }
                      onClick={() => handleMerge(batch.id)}
                    >
                      {batch.state === "failed"
                        ? "重试合并"
                        : batch.state === "merged"
                          ? "再次合并（只补缺项）"
                          : "执行合并"}
                    </Button>
                  </Group>

                  {batch.state === "merged" ? (
                    <Group gap="xs">
                      <CloudUpload size={14} color="var(--mantine-color-teal-7)" />
                      <Text size="xs" c="dimmed">
                        批次已合并完成；重复执行不会重复写入，仅会补入缺失项。
                      </Text>
                    </Group>
                  ) : null}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      )}
    </Paper>
  );
}
