import Head from "next/head";
import ReportDownload from "../components/ReportDownload";
import { useTranslation } from "react-i18next";

export default function ReportsPage() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>Reports | StellarEduPay</title>
      </Head>
      <ReportDownload />
    </>
  );
}
