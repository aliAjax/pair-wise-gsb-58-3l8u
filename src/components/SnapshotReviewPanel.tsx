import {
  Accordion,
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  ArchiveRestore,
  FileSearch,
  GitCommitHorizontal,
  ShieldQuestion,
} from "lucide-react";
import { useState } from "react";
import { SnapshotStateBadge } from "./Badges";
import type {
  ConclusionSnapshot,
  ImpactChange,
  ImpactReview,
} from "../models/types";
import {
  useBackfillSnapshotMutation,
  useRunImpactReviewMutation,
} from "../services/api";

interface SnapshotReviewPanelProps {
  caseId: string;
  snapshots: ConclusionSnapshot[];
  timelineVersion: string;
}

const changeKindLabel: Record<ImpactChange["kind"], string> = {
  evidence: "证据",
  node: "图谱节点",
  edge: "图谱关系",
  alert: "关联告警",
  timeline: "时间线",
};

const changeTypeColor: Record<ImpactChange["changeType"], string> = {
  added: "teal",
  removed: "red",
  modified: "orange",
};

const changeTypeLabel: Record<ImpactChange["changeType"], string> = {
  added: "新增",
  removed: "移除",
  modified: "修改",
};

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error && "error" in error) {
    return String(error.error);
  }
  return "操作失败，请稍后重试。";
};

export function SnapshotReviewPanel({
  caseId,
  snapshots,
  timelineVersion,
}: SnapshotReviewPanelProps) {
  const [backfill, { isLoading: isBackfilling }] =
    useBackfillSnapshotMutation();
  const [runReview, { isLoading: isReviewing }] =
    useRunImpactReviewMutation();
  const [reviews, setReviews] = useState<Record<string, ImpactReview>>({});

  const handleBackfill = async (snapshotId: string) => {
    try {
      await backfill({ caseId, snapshotId }).unwrap();
      notifications.show({
        color: "teal",
        title: "快照已补录核验",
        message: "旧数据快照已按当前线索核验，可以重新提交结论。",
      });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "补录失败",
        message: errorMessage(error),
      });
    }
  };

  const handleReview = async (snapshotId: string) => {
    try {
      const review = await runReview({ caseId }).unwrap();
      setReviews((current) => ({ ...current, [snapshotId]: review }));
      notifications.show({
        color: review.changes.length === 0 ? "teal" : "violet",
        title:
          review.changes.length === 0
            ? "复查无实质变更"
            : `复查发现 ${review.changes.length} 项受影响线索`,
        message:
          review.changes.length === 0
            ? "未受影响的线索已跳过，快照恢复有效。"
            : "未受影响的线索已跳过，请基于变化决定是否重新提交结论。",
      });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "影响复查失败",
        message: errorMessage(error),
      });
    }
  };

  if (snapshots.length === 0) {
    return (
      <Alert color="gray" icon={<GitCommitHorizontal size={16} />}>
        尚无结论快照。提交结论复核时会自动固化当时的证据、图谱关系与时间线版本。
      </Alert>
    );
  }

  return (
    <Stack gap="md">
      <Alert color="violet" icon={<ShieldQuestion size={16} />}>
        结论提交后所依据的证据、图谱关系、关联告警会被固化为快照；后续线索一旦变化，
        快照自动失效、案件进入待复议，但原裁定继续有效。影响复查只列出受影响资源，
        未变化的证据、节点、关系会跳过。
      </Alert>

      <Paper withBorder p="sm" bg="var(--mantine-color-gray-0)">
        <Group justify="space-between">
          <Text size="xs">当前案件时间线版本</Text>
          <Text size="xs" ff="monospace" fw={700}>
            {timelineVersion}
          </Text>
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          版本仅由证据、关系与关联告警决定；拖动图谱节点调整布局不会产生新版本。
        </Text>
      </Paper>

      <Accordion variant="separated" multiple defaultValue={snapshots.map((s) => s.id)}>
        {snapshots.map((snapshot) => (
          <SnapshotAccordionItem
            key={snapshot.id}
            snapshot={snapshot}
            review={reviews[snapshot.id]}
            isBackfilling={isBackfilling}
            isReviewing={isReviewing}
            onBackfill={() => void handleBackfill(snapshot.id)}
            onReview={() => void handleReview(snapshot.id)}
          />
        ))}
      </Accordion>
    </Stack>
  );
}

interface SnapshotItemProps {
  snapshot: ConclusionSnapshot;
  review?: ImpactReview;
  isBackfilling: boolean;
  isReviewing: boolean;
  onBackfill: () => void;
  onReview: () => void;
}

function SnapshotAccordionItem({
  snapshot,
  review,
  isBackfilling,
  isReviewing,
  onBackfill,
  onReview,
}: SnapshotItemProps) {
  return (
    <Accordion.Item value={snapshot.id}>
      <Accordion.Control>
        <Group gap="sm">
          <Text size="sm" fw={600}>
            V{snapshot.version} 结论快照
          </Text>
          <SnapshotStateBadge value={snapshot.state} />
          <Badge variant="light" color="gray">
            {snapshot.evidence.length} 证据 / {snapshot.nodes.length} 节点 /{" "}
            {snapshot.edges.length} 关系
          </Badge>
          <Text size="xs" c="dimmed" ff="monospace">
            {snapshot.timelineVersion}
          </Text>
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            固化时间：
            {new Date(snapshot.createdAt).toLocaleString("zh-CN", {
              hour12: false,
            })}
            {snapshot.backfilledAt
              ? ` · 补录核验：${new Date(snapshot.backfilledAt).toLocaleString("zh-CN", { hour12: false })}（${snapshot.backfilledBy}）`
              : ""}
          </Text>

          {snapshot.state === "pending_backfill" ? (
            <Alert color="yellow" icon={<ArchiveRestore size={16} />}>
              该结论产生于快照功能上线前，当前标记为旧数据待核。请核对固化内容与
              现有线索后补录；补录前不能重新提交结论，复核也无法通过。
              <Group mt="sm">
                <Button
                  size="xs"
                  color="yellow"
                  loading={isBackfilling}
                  onClick={onBackfill}
                >
                  核对无误，补录快照
                </Button>
              </Group>
            </Alert>
          ) : null}

          {snapshot.state === "stale" ? (
            <Alert color="violet">
              提交后线索发生变化，快照已失效，案件处于待复议；原裁定仍有效，
              不会被自动修改。可运行影响复查确认受影响范围，或在结论页重新提交。
              <Group mt="sm">
                <Button
                  size="xs"
                  color="violet"
                  leftSection={<FileSearch size={14} />}
                  loading={isReviewing}
                  onClick={onReview}
                >
                  运行影响复查
                </Button>
              </Group>
            </Alert>
          ) : null}

          {snapshot.state === "current" ? (
            <Group justify="space-between">
              <Text size="xs" c="teal" fw={600}>
                快照与当前线索一致，原裁定依据有效。
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                loading={isReviewing}
                onClick={onReview}
              >
                重新复查
              </Button>
            </Group>
          ) : null}

          {review ? <ReviewDetail review={review} /> : null}

          <Divider />
          <Table.ScrollContainer minWidth={560}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>固化资源</Table.Th>
                  <Table.Th>内容摘要</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {snapshot.evidence.map((item) => (
                  <Table.Tr key={`ev-${item.id}`}>
                    <Table.Td>
                      <Badge size="xs" variant="outline" color="gray">
                        证据
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">
                        {item.title} · {item.strength} · V{item.version}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {snapshot.nodes.map((item) => (
                  <Table.Tr key={`n-${item.id}`}>
                    <Table.Td>
                      <Badge size="xs" variant="outline" color="gray">
                        {item.kind}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">
                        {item.label} · {item.evidenceStrength}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {snapshot.edges.map((item) => (
                  <Table.Tr key={`e-${item.id}`}>
                    <Table.Td>
                      <Badge size="xs" variant="outline" color="gray">
                        {item.kind}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">
                        {item.source} → {item.target} · {item.label}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

function ReviewDetail({ review }: { review: ImpactReview }) {
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between">
        <Text size="xs" fw={700}>
          影响复查结果
        </Text>
        <Group gap={4}>
          <Text size="xs" c="dimmed">
            快照版本
          </Text>
          <Text size="xs" ff="monospace">
            {review.timelineVersion}
          </Text>
          <Text size="xs" c="dimmed">
            → 当前
          </Text>
          <Text size="xs" ff="monospace">
            {review.currentTimelineVersion}
          </Text>
        </Group>
      </Group>

      <SimpleGrid cols={5} spacing={6} mt="sm">
        {(
          [
            ["证据", review.unchanged.evidence],
            ["节点", review.unchanged.node],
            ["关系", review.unchanged.edge],
            ["告警", review.unchanged.alert],
            ["时间线", review.unchanged.timeline],
          ] as const
        ).map(([label, count]) => (
          <Paper key={label} withBorder p={6} ta="center">
            <Text size="lg" fw={700} c="teal">
              {count}
            </Text>
            <Text size="xs" c="dimmed">
              {label}未受影响
            </Text>
          </Paper>
        ))}
      </SimpleGrid>

      {review.changes.length === 0 ? (
        <Text size="xs" c="teal" mt="sm">
          未发现实质变化，未受影响资源全部跳过；快照已恢复有效。
        </Text>
      ) : (
        <Stack gap={6} mt="sm">
          {review.changes.map((change) => (
            <Group key={`${change.kind}-${change.changeType}-${change.resourceId}`} gap="xs" align="flex-start">
              <Badge size="xs" variant="light" color="gray">
                {changeKindLabel[change.kind]}
              </Badge>
              <Badge size="xs" color={changeTypeColor[change.changeType]}>
                {changeTypeLabel[change.changeType]}
              </Badge>
              <div>
                <Text size="xs" fw={600}>
                  {change.label}
                </Text>
                <Text size="xs" c="dimmed">
                  {change.detail}
                </Text>
              </div>
            </Group>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
