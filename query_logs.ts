import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const docId = 'cb339b53-8d66-475d-9ed9-974615449b1c';
  const logs = await prisma.auditLog.findMany({ where: { documentId: docId } });
  console.log(JSON.stringify(logs, null, 2));
}
main().catch(console.error);
