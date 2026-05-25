"""Math correctness of the core indicator helpers in quant_desk."""

import pandas as pd
import pytest


def test_sma_simple_window():
    from app.services.quant_desk import calculate_sma
    df = pd.DataFrame({"close": [1.0, 2.0, 3.0, 4.0, 5.0]})
    result = calculate_sma(df, period=3)
    # SMA(3) on [1,2,3,4,5] -> [NaN, NaN, 2.0, 3.0, 4.0]
    assert pd.isna(result.iloc[0])
    assert pd.isna(result.iloc[1])
    assert result.iloc[2] == pytest.approx(2.0)
    assert result.iloc[3] == pytest.approx(3.0)
    assert result.iloc[4] == pytest.approx(4.0)


def test_rsi_known_sequence():
    """RSI of a monotonic rising series should approach 100; flat should be ~50."""
    from app.services.quant_desk import calculate_rsi
    rising = pd.DataFrame({"close": [10 + i * 0.5 for i in range(20)]})
    result = calculate_rsi(rising, period=14)
    # Last value of monotonic-up should be very high (close to 100)
    assert result.iloc[-1] > 90
