interface Props {
  preliminary?: boolean;
  corrected?: boolean;
  basis?: 'adjusted' | 'gaap' | null;
}

/** Small muted labels after a value: preliminary until an official figure confirms it, corrected if it changed. */
export function Tags({ preliminary, corrected, basis }: Props) {
  return (
    <>
      {preliminary && <span className="tag"> preliminary</span>}
      {corrected && <span className="tag"> corrected</span>}
      {basis === 'gaap' && <span className="tag"> GAAP</span>}
    </>
  );
}
