import { useState } from "react";
import { ArrowDown, ArrowUp, Lock, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LOCKED_KANBAN_COLUMN_IDS } from "@/constants/kanban";
import { toast } from "@/hooks/use-toast";
import { useKanbanStore } from "@/store/kanban-store";

interface KanbanColumnManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KanbanColumnManagerDialog({ open, onOpenChange }: KanbanColumnManagerDialogProps) {
  const { getColumns, getCardsByStatus, renameColumn, reorderColumns, addColumn, deleteColumn } =
    useKanbanStore();
  const columns = getColumns();
  const [newLabel, setNewLabel] = useState("");

  const handleDelete = (columnId: string, label: string) => {
    const deleted = deleteColumn(columnId);
    if (!deleted) {
      toast({
        title: "Can't delete column",
        description: `Move the cards out of "${label}" first.`,
        variant: "destructive",
      });
    }
  };

  const handleAdd = () => {
    if (!newLabel.trim()) return;
    addColumn(newLabel.trim());
    setNewLabel("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Kanban Columns</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {columns.map((column, index) => {
            const isLocked = LOCKED_KANBAN_COLUMN_IDS.includes(column.id);
            return (
              <div key={column.id} className="flex items-center gap-1.5">
                <Input
                  value={column.label}
                  onChange={(e) => renameColumn(column.id, e.target.value)}
                  className="h-8 text-[13px]"
                />
                <span className="text-muted-foreground w-8 shrink-0 text-center text-[11px] tabular-nums">
                  {getCardsByStatus(column.id).length}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  disabled={index === 0}
                  onClick={() => reorderColumns(column.id, columns[index - 1].id)}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  disabled={index === columns.length - 1}
                  onClick={() => reorderColumns(column.id, columns[index + 1].id)}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                {isLocked ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled
                    className="text-muted-foreground/60 h-8 w-8 shrink-0 disabled:opacity-100"
                    title="Required column — can't be deleted"
                  >
                    <Lock className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive h-8 w-8 shrink-0"
                    onClick={() => handleDelete(column.id, column.label)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex gap-1.5 border-t pt-3">
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="New column name"
            className="h-8 text-[13px]"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
          />
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={handleAdd}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
