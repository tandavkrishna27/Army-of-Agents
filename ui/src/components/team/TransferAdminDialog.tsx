import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TeamMemberSummary } from "@armyofagents/shared";
import { teamApi } from "../../api/team";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TransferAdminDialogProps {
  companyId: string;
  founders: TeamMemberSummary[];
  currentUserId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TransferAdminDialog({
  companyId,
  founders,
  currentUserId,
  open,
  onOpenChange,
}: TransferAdminDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [targetUserId, setTargetUserId] = useState<string>("none");
  const [confirmation, setConfirmation] = useState("");

  const otherFounders = founders.filter((f) => f.userId !== currentUserId);

  const transferMutation = useMutation({
    mutationFn: () =>
      teamApi.transferAdmin(companyId, {
        toUserId: targetUserId,
        confirmation: "TRANSFER",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.team.summary(companyId) });
      pushToast({ title: "Admin transferred", tone: "success" });
      onOpenChange(false);
      reset();
    },
    onError: (err: Error) => {
      pushToast({ title: "Transfer failed", body: err.message, tone: "error" });
    },
  });

  function reset() {
    setTargetUserId("none");
    setConfirmation("");
  }

  const canSubmit =
    targetUserId !== "none" &&
    confirmation === "TRANSFER" &&
    !transferMutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer System Admin</DialogTitle>
          <DialogDescription>
            Transfer your system admin rights to another founder. This action cannot be undone without the new admin&apos;s cooperation.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
            <strong>Warning:</strong> You will lose system admin privileges. The new admin will be the only person who can add/remove founders and transfer admin.
          </div>

          <div className="space-y-1.5">
            <Label>Transfer to</Label>
            <Select value={targetUserId} onValueChange={setTargetUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a founder" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Select a founder</SelectItem>
                {otherFounders.map((f) => (
                  <SelectItem key={f.userId} value={f.userId}>
                    {f.displayName ?? f.email ?? f.userId.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="transfer-confirm">
              Type <strong>TRANSFER</strong> to confirm
            </Label>
            <Input
              id="transfer-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder="TRANSFER"
            />
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => { onOpenChange(false); reset(); }}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => transferMutation.mutate()}
            disabled={!canSubmit}
          >
            {transferMutation.isPending ? "Transferring..." : "Transfer Admin"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
