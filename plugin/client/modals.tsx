import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { acceptInvite, createInvite, listAgents, type AgentSummary } from "../shared/contracts";
import { Button, Label, errorText, inputStyle } from "./kit";

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
  const agents = useQuery({ queryKey: ["peers-agents"], queryFn: () => fetchAgents({}), enabled: props.open, staleTime: 2000 });

  async function pick(agent: AgentSummary | null) {
    setPending(agent?.id ?? "none");
    try {
      await props.onPick(agent);
      props.onClose();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setPending(null);
    }
  }

  const row = (key: string, title: string, subtitle: string | null, status: string | null, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={pending !== null}
      onPress={onPress}
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
      <Icon name={key === "none" ? "Hand" : "Bot"} size={16} color={c.foregroundMuted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.foreground, fontSize: 14 }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {status ? (
        <Text style={{ color: status === "running" ? c.statusWarning : c.foregroundMuted, fontSize: 12 }}>{status === "running" ? "busy" : status}</Text>
      ) : null}
      {pending === key ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}
    </Pressable>
  );

  return (
    <Modal title={props.title} open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        {props.allowNone ? row("none", "Off: ask me each time", "Messages wait in the inbox", null, () => void pick(null)) : null}
        {agents.isLoading ? <ActivityIndicator color={c.foregroundMuted} /> : null}
        {agents.error ? <Text style={{ color: c.statusDanger }}>{errorText(agents.error)}</Text> : null}
        {agents.data?.agents.length === 0 ? <Text style={{ color: c.foregroundMuted }}>No active agents on this host.</Text> : null}
        {agents.data?.agents.map((agent) => row(agent.id, agent.title, agent.cwd, agent.status, () => void pick(agent)))}
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
