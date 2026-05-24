import MetaTrader5 as mt5
from app.services.mt5_connector import get_active_orders, resolve_symbol
from app.core.database import SessionLocal, TradeState, log_action

def manage_active_trades():
    """
    Called every H1 interval to manage trailing stops and breakeven migration.
    """
    positions = mt5.positions_get()
    if positions is None:
        return
        
    db = SessionLocal()
    try:
        for pos in positions:
            sym = pos.symbol
            profit = pos.profit
            entry = pos.price_open
            sl = pos.sl
            tp = pos.tp
            ticket = pos.ticket
            
            # Fetch TradeState to get Initial SL distance
            state = db.query(TradeState).filter(TradeState.ticket == ticket).first()
            if not state:
                continue
                
            initial_sl_distance = abs(state.entry_price - state.sl)
            if initial_sl_distance == 0:
                continue
                
            # Check Breakeven Migration (1.0x D_SL)
            # Assuming profit is in account currency, but let's use price distance
            current_price = pos.price_current
            price_distance = abs(current_price - entry)
            
            is_buy = pos.type == mt5.ORDER_TYPE_BUY
            
            # Breakeven Migration logic
            if price_distance >= initial_sl_distance:
                # Need to move SL to breakeven if not already there or better
                if is_buy and sl < entry:
                    _modify_sl(ticket, sym, entry)
                    log_action("TradeManager", "Breakeven", f"Moved SL to entry for {sym} (Ticket {ticket})")
                elif not is_buy and sl > entry:
                    _modify_sl(ticket, sym, entry)
                    log_action("TradeManager", "Breakeven", f"Moved SL to entry for {sym} (Ticket {ticket})")
                    
            # Basic Chandelier Exit could be implemented here as well
            
    finally:
        db.close()

def _modify_sl(ticket, symbol, new_sl):
    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "position": ticket,
        "symbol": symbol,
        "sl": float(new_sl),
        "tp": 0.0, # Keep existing TP? MT5 requires TP to be set if modifying SL, need to check
    }
    
    # We need to get current TP to preserve it
    pos = mt5.positions_get(ticket=ticket)
    if pos:
        request["tp"] = pos[0].tp
        
    mt5.order_send(request)
