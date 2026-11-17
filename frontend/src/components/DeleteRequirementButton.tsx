import { Button } from '@appica/ui-react/button'
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from '@appica/ui-react/alert-dialog'
import type { Project } from '../lib/api'

/** 删除需求：AlertDialog 二次确认后调用 DELETE /api/projects/:id（其下文档等关联数据一并清理，不可恢复） */
export function DeleteRequirementButton({
  project,
  onDeleted,
}: {
  project: Project
  onDeleted: (id: number) => void
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" />}>
        删除
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除需求</AlertDialogTitle>
          <AlertDialogDescription>
            确定删除「{project.name}」吗？其下的文档会一并删除，且不可恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose>
            <Button variant="outline" size="sm">取消</Button>
          </AlertDialogClose>
          <AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => onDeleted(project.id)}
            >
              确认删除
            </Button>
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}