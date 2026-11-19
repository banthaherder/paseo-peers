import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { acceptInvite, createInvite, listAgents, type AgentSummary } from "../shared/contracts";
import { Button, Label, errorText, inputStyle } from "./kit";

function Chip({ theme, icon, text }: { theme: PluginTheme; icon: string; text: string }) {
  const c = theme.colors;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: c.surface2,
        borderWidth: 1,
        borderColor: c.border,
        maxWidth: 220,
      }}
    >
      <Icon name={icon} size={11} color={c.foregroundMuted} />
      <Text style={{ color: c.foreground, fontSize: 11 }} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const statusText = (status: string) => (status === "running" ? "busy" : status);

/** One agent, identified by its workspace, project, branch and workspace labels. Hides itself when it doesn't match `query`. */
function AgentRow(props: { theme: PluginTheme; agent: AgentSummary; query: string; pending: boolean; disabled: boolean; onPress(): void }) {
  const { theme, agent } = props;
  const c = theme.colors;
  const labels = useWorkspace(agent.workspaceId ?? "none", (workspace) => workspace.labels) ?? [];
  const heading = agent.workspaceName || agent.title;
  const subtitle = agent.workspaceName && agent.workspaceName !== agent.title ? agent.title : null;
  const query = props.query.trim().toLowerCase();
  if (query) {
    const haystack = [heading, agent.title, agent.projectName, agent.branch, agent.cwd, ...labels].join(" ").toLowerCase();
    if (!query.split(/\s+/).every((word) => haystack.includes(word))) return null;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${heading}${agent.projectName ? `, project ${agent.projectName}` : ""}${labels.length ? `, labels ${labels.join(", ")}` : ""}, ${statusText(agent.status)}`}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        padding: 10,
        borderRadius: 8,
        backgroundColor: pressed ? c.surface2 : c.surface1,
        borderWidth: 1,
        borderColor: c.border,
        opacity: agent.status === "closed" ? 0.75 : 1,
      })}
    >
      <Icon name="Bot" size={16} color={c.foregroundMuted} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "500" }} numberOfLines={1}>
          {heading}
        </Text>
        {subtitle ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
          {agent.projectName ? <Chip theme={theme} icon="FolderGit2" text={agent.projectName} /> : null}
          {agent.branch ? <Chip theme={theme} icon="GitBranch" text={agent.branch} /> : null}
          {labels.map((label) => (
            <Chip key={label} theme={theme} icon="Tag" text={label} />
          ))}
          {agent.cwd ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 11, flexShrink: 1 }} numberOfLines={1}>
              {agent.cwd}
            </Text>
          ) : null}
        </View>
      </View>
      <Text style={{ color: agent.status === "running" ? c.statusWarning : c.foregroundMuted, fontSize: 12 }}>{statusText(agent.status)}</Text>
      {props.pending ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}
    </Pressable>
  );
}

/** Picks one of this host's agents. `allowNone` adds an "Off" row (for auto-delivery). */
export function AgentPickerModal(props: {
  theme: PluginTheme;
  open: boolean;
  title: string;
  allowNone?: boolean;
  onClose(): void;
  onPick(agent: AgentSummary | null): Promise<void>;
}) {
  const { theme } = props;
  const c = theme.colors;
  const fetchAgents = useRpc(listAgents);
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const agents = useQuery({ queryKey: ["peers-agents"], queryFn: () => fetchAgents({}), enabled: props.open, staleTime: 2000 });

  async function pick(agent: AgentSummary | null) {
    setPending(agent?.id ?? "none");
    try {
      await props.onPick(agent);
      setQuery("");
      props.onClose();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setPending(null);
    }
  }

  return (
    <Modal
      title={props.title}
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
          props.onClose();
        }
      }}
    >
      <Modal.Content>
        {props.allowNone ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Off: ask me each time"
            disabled={pending !== null}
            onPress={() => void pick(null)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              padding: 10,
              borderRadius: 8,
              backgroundColor: pressed ? c.surface2 : c.surface1,
              borderWidth: 1,
              borderColor: c.border,
            })}
          >
            <Icon name="Hand" size={16} color={c.foregroundMuted} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: c.foreground, fontSize: 14 }}>Off: ask me each time</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Messages wait in the inbox</Text>
            </View>
            {pending === "none" ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}
          </Pressable>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="Search" size={14} color={c.foregroundMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Filter by name, project, branch, label or folder"
            placeholderTextColor={c.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[inputStyle(theme), { flex: 1 }]}
          />
        </View>
        {agents.isLoading ? <ActivityIndicator color={c.foregroundMuted} /> : null}
        {agents.error ? <Text style={{ color: c.statusDanger }}>{errorText(agents.error)}</Text> : null}
        {agents.data?.agents.length === 0 ? <Text style={{ color: c.foregroundMuted }}>No active agents on this host.</Text> : null}
        {agents.data?.agents.map((agent) => (
          <AgentRow
            key={agent.id}
            theme={theme}
            agent={agent}
            query={query}
            pending={pending === agent.id}
            disabled={pending !== null}
            onPress={() => void pick(agent)}
          />
        ))}
        {!props.allowNone ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>A busy agent gets the message as soon as its current turn ends.</Text>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

export function InviteModal({ theme, open, onClose }: { theme: PluginTheme; open: boolean; onClose(): void }) {
  const c = theme.colors;
  const create = useRpc(createInvite);
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [result, setResult] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setResult(null);
    setLabel("");
    setError(null);
    onClose();
  };

  return (
    <Modal title="Invite a peer" open={open} onOpenChange={(next) => !next && close()}>
      <Modal.Content>
        {!result ? (
          <>
            <Text style={{ color: c.foreground, fontSize: 14 }}>
              Creates a one-time invite code. Send it to them once, over any channel. When they paste it into Paseo Peers, you're paired.
            </Text>
            <Label theme={theme}>Who is it for? (optional)</Label>
            <TextInput value={label} onChangeText={setLabel} placeholder="Their name" placeholderTextColor={c.foregroundMuted} style={inputStyle(theme)} />
            {error ? <Text style={{ color: c.statusDanger }}>{error}</Text> : null}
            <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
              <Button
                theme={theme}
                tone="primary"
                icon="Ticket"
                label="Create invite code"
                onPress={async () => {
                  setError(null);
                  try {
                    setResult(await create({ label: label.trim() || undefined }));
                  } catch (e) {
                    setError(errorText(e));
                  }
                }}
              />
            </View>
          </>
        ) : (
          <>
            <Text style={{ color: c.foreground, fontSize: 14 }}>
              Send this code{label ? ` to ${label}` : ""}. It works once and expires {new Date(result.expiresAt).toLocaleDateString()}.
            </Text>
            <View style={{ backgroundColor: c.surface0, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 10 }}>
              <Text selectable style={{ color: c.foreground, fontFamily: "Menlo", fontSize: 11 }}>
                {result.code}
              </Text>
            </View>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
              The code holds the relay address, a single-use relay pass and your public keys. It doesn't include any secret that could read your messages.
            </Text>
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
              <Button
                theme={theme}
                icon="Copy"
                label="Copy"
                onPress={async () => {
                  try {
                    await copyText(result.code);
                    toast.show("Invite code copied", { variant: "success" });
                  } catch (e) {
                    toast.error(errorText(e));
                  }
                }}
              />
              <Button theme={theme} tone="primary" label="Done" onPress={close} />
            </View>
          </>
        )}
      </Modal.Content>
    </Modal>
  );
}

export function JoinModal(props: { theme: PluginTheme; open: boolean; defaultName: string; onClose(): void; onJoined(peerId: string): void }) {
  const { theme } = props;
  const c = theme.colors;
  const accept = useRpc(acceptInvite);
  const toast = useToast();
  const [code, setCode] = useState("");
  const [name, setName] = useState(props.defaultName);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title="Join with an invite code" open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        <Label theme={theme}>Your name, as the other person will see it</Label>
        <TextInput value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={c.foregroundMuted} style={inputStyle(theme)} />
        <Label theme={theme}>Invite code</Label>
        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="paseo-peer:…"
          placeholderTextColor={c.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[inputStyle(theme, true), { fontFamily: "Menlo", fontSize: 11 }]}
        />
        {error ? <Text style={{ color: c.statusDanger }}>{error}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Button
            theme={theme}
            tone="primary"
            icon="Link"
            label="Pair"
            disabled={!code.trim() || !name.trim()}
            onPress={async () => {
              setError(null);
              try {
                const result = await accept({ code, name: name.trim() });
                toast.show(`Paired with ${result.peerName}`, { variant: "success" });
                setCode("");
                props.onJoined(result.peerId);
                props.onClose();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
