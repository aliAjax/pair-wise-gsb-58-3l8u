import {
  Alert,
  Badge,
  Button,
  Group,
  List,
  Paper,
  Stack,
  Table,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  AlertTriangle,
  ArchiveRestore,
  Camera,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type {
  ConclusionSnapshot,
  ConclusionVersion,
  SnapshotImpactItem,
} from "../../models/types";
import { SnapshotStatusBadge } from "../../components/Badges";
import {
  useBackfillSnapshotMutation,
  useRecheckSnapshotsMutation,
} from "../../services/api";

const formatTime = (value?: string) =>
  value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "—";

const impactColor: Record<SnapshotImpactItem["changeType"], string> = {
  added: "teal",
  removed: "red",
  modified: "orange",
};

const impactLabel: Record<SnapshotImpactItem["changeType"], string> = {
  added: "新增",
  removed: "移除",
  modified: "修改",
};

const categoryLabel: Record<SnapshotImpactItem["category"], string> = {
  evidence: "证据",
  node: "图谱节点",
  edge: "图谱关系",
  timeline: "时间线",
};

interface SnapshotPanelProps {
  caseId: string;
  conclusion: ConclusionVersion;
  snapshot?: ConclusionSnapshot;
}

export function SnapshotPanel({
  caseId,
  conclusion,
  snapshot,
}: SnapshotPanelProps) {
  const [backfill, { isLoading: isBackfilling }] =
    useBackfillSnapshotMutation();
  const [recheck, { isLoading: isRechecking }] = useRecheckSnapshotsMutation();

  const handleBackfill = async () => {
    try {
      await backfill({ caseId, conclusionId: conclusion.id }).unwrap();
      notifications.show({
        color: "teal",
        title: "快照已补录",
        message: "已按当前核对后的线索固化版本，待核标记解除，可重新提交结论。",
      });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "补录失败",
        message:
          typeof error === "object" && error && "error" in error
            ? String(error.error)
            : "快照补录失败。",
      });
    }
  };

  const handleRecheck = async () => {
    try {
      const result = await recheck({ caseId }).unwrap();
      notifications.show({
        color: result.enteredReconsider ? "grape" : "teal",
        title: "影响复查完成",
        message: result.enteredReconsider
          ? "检测到影响结论的线索变化，案件已转为待复议；原裁定仍有效。"
          : "证据、图谱关系与时间线未受影响，快照继续有效。",
      });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "复查失败",
        message:
          typeof error === "object" && error && "error" in error
            ? String(error.error)
            : "影响复查失败。",
      });
    }
  };

  if (!snapshot) {
    return (
      <Alert color="gray" icon={<Camera size={16} />} variant="light">
        草稿版本不固化快照；提交复核时才会冻结证据、图谱关系与时间线版本。
      </Alert>
    );
  }

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" align="flex-start">
        <Group gap="xs">
          <ThemeIcon variant="light" color={snapshot.status === "stale" ? "grape" : "teal"}>
            {snapshot.status === "stale" ? (
              <AlertTriangle size={16} />
            ) : (
              <ShieldCheck size={16} />
            )}
          </ThemeIcon>
          <div>
            <Group gap="xs">
              <Text size="sm" fw={700}>
                结论快照 {snapshot.id}
              </Text>
              <SnapshotStatusBadge value={snapshot.status} />
              {snapshot.backfilled ? (
                <Badge variant="outline" color="yellow">
                  补录
                </Badge>
              ) : null}
            </Group>
            <Text size="xs" c="dimmed" mt={3}>
              固化于 {formatTime(snapshot.createdAt)}
              {snapshot.recheckedAt
                ? ` · 最近复查 ${formatTime(snapshot.recheckedAt)}`
                : ""}
            </Text>
          </div>
        </Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<RefreshCw size={14} />}
          loading={isRechecking}
          onClick={handleRecheck}
        >
          立即复查
        </Button>
      </Group>

      <Group gap="xs" mt="md">
        <Badge variant="light" color="gray">
          证据 ×{snapshot.evidenceCount}
        </Badge>
        <Badge variant="light" color="gray">
          节点 ×{snapshot.nodeCount}
        </Badge>
        <Badge variant="light" color="gray">
          关系 ×{snapshot.edgeCount}
        </Badge>
        <Badge variant="light" color="gray">
          时间线 ×{snapshot.timelineCount}
        </Badge>
      </Group>

      <Text size="xs" c="dimmed" mt="xs" ff="monospace">
        EV {snapshot.evidenceVersion} · NODE {snapshot.nodeVersion} · EDGE{" "}
        {snapshot.edgeVersion} · TL {snapshot.timelineVersion}
      </Text>

      {snapshot.status === "pending_backfill" ? (
        <Alert color="yellow" mt="md" title="旧数据 · 待核">
          <Stack gap="sm" align="flex-start">
            <Text size="sm">
              {snapshot.recheckNote ??
                "该结论缺少提交时快照，补录核对前不能重新提交结论。"}
            </Text>
            <Button
              size="xs"
              color="yellow"
              leftSection={<ArchiveRestore size={14} />}
              loading={isBackfilling}
              onClick={handleBackfill}
            >
              补录快照（按当前已核对线索固化）
            </Button>
          </Stack>
        </Alert>
      ) : null}

      {snapshot.status === "stale" ? (
        <Alert color="grape" mt="md" title="快照失效 · 待复议">
          <Stack gap="sm">
            <Text size="sm">
              {snapshot.recheckNote ??
                "提交依据已发生变化，原裁定在复议期间继续有效；请基于新材料重新提交结论。"}
            </Text>
            {snapshot.impacts.length > 0 ? (
              <Table.ScrollContainer minWidth={420}>
                <Table withRowBorders={false} horizontalSpacing={0}>
                  <Table.Tbody>
                    {snapshot.impacts.map((impact) => (
                      <Table.Tr key={impact.id}>
                        <Table.Td style={{ width: 90 }}>
                          <Badge
                            size="xs"
                            variant="light"
                            color={impactColor[impact.changeType]}
                          >
                            {impactLabel[impact.changeType]}
                          </Badge>
                        </Table.Td>
                        <Table.Td style={{ width: 84 }}>
                          <Text size="xs" c="dimmed">
                            {categoryLabel[impact.category]}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" fw={600}>
                            {impact.label}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {impact.detail}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            ) : (
              <List size="xs" c="dimmed">
                <List.Item>影响项列表为空，可再次执行复查。</List.Item>
              </List>
            )}
          </Stack>
        </Alert>
      ) : null}

      {snapshot.status === "verified" ? (
        <Text size="xs" c="dimmed" mt="md">
          复查仅比对证据、节点内容、图谱关系与时间线版本；仅调整节点布局位置不会使快照失效。
        </Text>
      ) : null}
    </Paper>
  );
}
