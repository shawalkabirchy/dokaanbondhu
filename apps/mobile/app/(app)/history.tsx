import { useTranslation } from "react-i18next";
import { Note, Screen } from "../../src/ui";

export default function History() {
  const { t } = useTranslation();
  return (
    <Screen>
      <Note>{t("history.coming")}</Note>
    </Screen>
  );
}
