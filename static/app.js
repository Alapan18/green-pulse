// ===== Energy Management System Class =====
class EnergyManagementSystem {
    constructor() {
        this.state = {
            solar: 0,
            wind: 0,
            battery: 55,
            grid: 0, // Legacy - now using gridImport
            gridImport: 0,
            gridExport: 0,
            totalGeneration: 0,
            load: 6.0,
            demand: 0,
            batteryPriority: 50,
            reserve: 20,
            exportDemand: 0, // Export demand from external consumers
            temperature: 31,
            windSpeed: 6,
            cloudCover: 40,
            irradiance: 800,
            isHoliday: false,
            dataPoints: 0,
            history: { solar: [], wind: [], grid: [], battery: [] },
            forecast: { solar: [], wind: [], grid: [], battery: [] },
            historical: { solar: [], wind: [], grid: [], battery: [] },
            currentTab: 'realtime',
            co2ReducedTotal: parseFloat(localStorage.getItem('co2ReducedTotal')) || 0,
            costSavingsTotal: parseFloat(localStorage.getItem('costSavingsTotal')) || 0,
            // <new section grid import line>
            gridImportAmount: 0,
            gridImportCostTotal: parseFloat(localStorage.getItem('gridImportCostTotal')) || 0,
            // </new section grid import line>
            // Cumulative export metrics
            gridExportTotal: parseFloat(localStorage.getItem('gridExportTotal')) || 0,
            gridExportIncome: parseFloat(localStorage.getItem('gridExportIncome')) || 0
        };
        this.updateInterval = null;
    }

    updateFromBackend(predictions, tickData, nextHourPrediction = null) {
        try {
            // Update AI predictions
            this.state.solar = parseFloat(predictions.solar_gen) || 0;
            this.state.wind = parseFloat(predictions.wind_gen) || 0;
            this.state.demand = parseFloat(predictions.demand_forecast) || 0;
            
            // Store next-hour prediction if provided
            if (nextHourPrediction) {
                this.state.nextHourPrediction = {
                    solar: parseFloat(nextHourPrediction.solar_gen) || 0,
                    wind: parseFloat(nextHourPrediction.wind_gen) || 0,
                    demand: parseFloat(nextHourPrediction.demand_forecast) || 0
                };
            }
            
            // Use Site Load value (this.state.load) which is controlled by consumption slider
            // this.state.load is set by the consumption slider in the event listener
            
            // Calculate energy balance (WITHOUT grid import from slider)
            const generation = this.state.solar + this.state.wind;
            const balance = generation - this.state.load;
            
            // Battery capacity: 1% = 500 kWh (Total: 100% = 50,000 kWh)
            // Since we're calculating per tick (hourly), we use the rate directly
            const batteryCapacityPerPercent = 500; // kWh per 1%
            
            // Grid import from slider is ONLY for battery charging (independent of energy balance)
            const gridImportForBattery = this.state.gridImportAmount || 0;
            
            console.log(`[ENERGY FLOW] Generation: ${generation.toFixed(2)} kW, Load: ${this.state.load.toFixed(2)} kW, Balance: ${balance.toFixed(2)} kW`);
            console.log(`[GRID IMPORT FOR BATTERY] Amount: ${gridImportForBattery.toFixed(2)} kW (for battery charging only)`);
            console.log(`[BATTERY] Level: ${this.state.battery.toFixed(1)}%, Priority: ${this.state.batteryPriority}%, Reserve: ${this.state.reserve}%`);
            
            // STEP 1: Charge battery from grid import (independent of energy balance)
            if (gridImportForBattery > 0 && this.state.battery < 100) {
                const batteryChargeFromGridPercent = gridImportForBattery / batteryCapacityPerPercent;
                const oldBattery = this.state.battery;
                this.state.battery = Math.min(100, this.state.battery + batteryChargeFromGridPercent);
                console.log(`[GRID→BATTERY] Charged battery with ${gridImportForBattery.toFixed(2)} kW from grid, ${oldBattery.toFixed(1)}% → ${this.state.battery.toFixed(1)}%`);
            }
            
            // STEP 2: Handle main energy balance (existing logic continues unchanged)
            
            if (balance < 0) {
                // DEFICIT CASE: Not enough generation to meet demand
                const deficit = -balance; // Positive value in kW
                
                console.log(`[DEFICIT] Deficit: ${deficit.toFixed(2)} kW, Export Demand: ${this.state.exportDemand.toFixed(2)} kW`);
                
                // CONTINUOUS EXPORT: Check if we need to export even during deficit
                let totalBatteryDrain = 0;
                let exportFromBattery = 0;
                
                if (this.state.exportDemand > 0 && this.state.battery > this.state.reserve) {
                    // Calculate how much battery we have above reserve
                    const batteryAboveReserve = this.state.battery - this.state.reserve;
                    const maxExportFromBattery = batteryAboveReserve * batteryCapacityPerPercent; // kWh available
                    
                    // Try to meet export demand from battery
                    exportFromBattery = Math.min(this.state.exportDemand, maxExportFromBattery);
                    this.state.gridExport = exportFromBattery;
                    console.log(`[EXPORT FROM BATTERY] Export during deficit: ${exportFromBattery.toFixed(2)} kW`);
                } else {
                    this.state.gridExport = 0;
                }
                
                // Battery Discharge for site load (if capacity > reserve)
                if (this.state.battery > this.state.reserve) {
                    // Battery drains at: deficit * battery_priority / 100 per tick
                    const batteryDrainKW = deficit * (this.state.batteryPriority / 100);
                    totalBatteryDrain = batteryDrainKW + exportFromBattery;
                    
                    // Convert kW to % change: kW / batteryCapacityPerPercent
                    const batteryDrainPercent = totalBatteryDrain / batteryCapacityPerPercent;
                    const oldBattery = this.state.battery;
                    this.state.battery = Math.max(this.state.reserve, this.state.battery - batteryDrainPercent);
                    console.log(`[BATTERY DISCHARGE] Total drain: ${totalBatteryDrain.toFixed(2)} kW (${batteryDrainKW.toFixed(2)} kW for load + ${exportFromBattery.toFixed(2)} kW for export), ${oldBattery.toFixed(1)}% → ${this.state.battery.toFixed(1)}%`);
                } else {
                    console.log(`[BATTERY PROTECTED] Battery at or below reserve (${this.state.reserve}%)`);
                }
                
                // Grid Import
                if (this.state.battery > this.state.reserve) {
                    // Grid imports: deficit * (100 - battery_priority) / 100
                    this.state.gridImport = deficit * ((100 - this.state.batteryPriority) / 100);
                    console.log(`[GRID IMPORT] Import: ${this.state.gridImport.toFixed(2)} kW`);
                } else {
                    // Battery at or below reserve, import full deficit from grid
                    this.state.gridImport = deficit;
                    console.log(`[GRID IMPORT] Full deficit import: ${this.state.gridImport.toFixed(2)} kW`);
                }
                
            } else {
                // SURPLUS CASE: Generation exceeds demand
                const surplus = balance; // Positive value in kW
                
                console.log(`[SURPLUS] Surplus: ${surplus.toFixed(2)} kW, Export Demand: ${this.state.exportDemand.toFixed(2)} kW`);
                
                // CONTINUOUS EXPORT LOGIC: Always try to export at Export Demand rate
                if (this.state.exportDemand > 0) {
                    // Check if battery is above reserve (can export from battery if needed)
                    const canExportFromBattery = this.state.battery > this.state.reserve;
                    
                    if (!canExportFromBattery) {
                        // Battery at or below reserve - STOP ALL EXPORT
                        this.state.gridExport = 0;
                        console.log(`[EXPORT STOPPED] Battery at reserve (${this.state.reserve}%), stopping all export`);
                        
                        // All surplus goes to battery charging
                        if (this.state.battery < 100) {
                            const batteryRechargePercent = surplus / batteryCapacityPerPercent;
                            const oldBattery = this.state.battery;
                            this.state.battery = Math.min(100, this.state.battery + batteryRechargePercent);
                            console.log(`[BATTERY CHARGE] All surplus to battery: ${surplus.toFixed(2)} kW, ${oldBattery.toFixed(1)}% → ${this.state.battery.toFixed(1)}%`);
                        }
                    } else {
                        // Battery is above reserve - can export continuously
                        const batteryAboveReserve = this.state.battery - this.state.reserve;
                        const maxExportFromBattery = batteryAboveReserve * batteryCapacityPerPercent; // kWh available
                        
                        // Try to export the full Export Demand
                        let exportAmount = this.state.exportDemand;
                        let exportFromBattery = 0;
                        
                        if (surplus >= exportAmount) {
                            // Surplus covers full export demand
                            this.state.gridExport = exportAmount;
                            console.log(`[EXPORT FROM SURPLUS] Export: ${exportAmount.toFixed(2)} kW (fully from surplus)`);
                            
                            // Remaining surplus goes to battery
                            const remainingSurplus = surplus - exportAmount;
                            if (remainingSurplus > 0 && this.state.battery < 100) {
                                const batteryRechargePercent = remainingSurplus / batteryCapacityPerPercent;
                                const oldBattery = this.state.battery;
                                this.state.battery = Math.min(100, this.state.battery + batteryRechargePercent);
                                console.log(`[BATTERY CHARGE] Remaining surplus: ${remainingSurplus.toFixed(2)} kW, ${oldBattery.toFixed(1)}% → ${this.state.battery.toFixed(1)}%`);
                            }
                        } else {
                            // Surplus is not enough - need to draw from battery
                            exportFromBattery = exportAmount - surplus;
                            
                            // Check if we have enough battery capacity
                            if (exportFromBattery <= maxExportFromBattery) {
                                // Can meet full export demand
                                this.state.gridExport = exportAmount;
                                const batteryDrainPercent = exportFromBattery / batteryCapacityPerPercent;
                                const oldBattery = this.state.battery;
                                this.state.battery = Math.max(this.state.reserve, this.state.battery - batteryDrainPercent);
                                console.log(`[EXPORT HYBRID] Export: ${exportAmount.toFixed(2)} kW (${surplus.toFixed(2)} kW from surplus + ${exportFromBattery.toFixed(2)} kW from battery), Battery: ${oldBattery.toFixed(1)}% → ${this.state.battery.toFixed(1)}%`);
                            } else {
                                // Can only partially meet export demand (battery limiting)
                                exportAmount = surplus + maxExportFromBattery;
                                this.state.gridExport = exportAmount;
                                const oldBattery = this.state.battery;
                                this.state.battery = this.state.reserve; // Drain to reserve
                                console.log(`[EXPORT LIMITED] Export: ${exportAmount.toFixed(2)} kW (limited by battery reserve), Battery: ${oldBattery.toFixed(1)}% → ${this.state.battery.toFixed(1)}%`);
                            }
                        }
                    }
                } else {
                    // No export demand - standard charging logic
                    if (this.state.battery < 100) {
                        const batteryRechargePercent = surplus / batteryCapacityPerPercent;
                        const oldBattery = this.state.battery;
                        this.state.battery = Math.min(100, this.state.battery + batteryRechargePercent);
                        this.state.gridExport = 0;
                        console.log(`[BATTERY CHARGE] No export demand, charging: ${surplus.toFixed(2)} kW, ${oldBattery.toFixed(1)}% → ${this.state.battery.toFixed(1)}%`);
                    } else {
                        // Battery full and no export demand - export surplus anyway
                        this.state.gridExport = surplus;
                        console.log(`[GRID EXPORT] Battery full, no export demand, exporting surplus: ${surplus.toFixed(2)} kW`);
                    }
                }
                
                // No grid import during surplus
                this.state.gridImport = 0;
            }
            
            // Legacy grid property (for backward compatibility, use gridImport)
            this.state.grid = this.state.gridImport || 0;
            
            // Total generation (for new card)
            this.state.totalGeneration = generation;
            
            // Update data points counter
            this.state.dataPoints++;
            
            // Update history for charts
            this.updateHistory();
            
            // Refresh UI
            this.updateKPIs();
            this.updateCharts();
            this.updateAIRecommendations();
            this.updateLastUpdate();
        } catch (err) {
            console.error('Error updating from backend:', err);
        }
    }

    updateHistory() {
        const maxHistory = 30;
        if (!this.state.history) {
            this.state.history = { solar: [], wind: [], grid: [], battery: [] };
        }
        this.state.history.solar.push(this.state.solar);
        this.state.history.wind.push(this.state.wind);
        this.state.history.grid.push(this.state.grid);
        this.state.history.battery.push(this.state.battery);
        
        Object.keys(this.state.history).forEach(key => {
            if (this.state.history[key].length > maxHistory) {
                this.state.history[key].shift();
            }
        });
    }

    updateCharts() {
        if (!this.state.history) {
            this.state.history = { solar: [], wind: [], grid: [], battery: [] };
        }
        
        let dataSource = this.state.history;
        if (this.state.currentTab === 'forecast' && this.state.forecast) {
            dataSource = this.state.forecast;
        } else if (this.state.currentTab === 'historical' && this.state.historical) {
            dataSource = this.state.historical;
        }
        
        this.renderChart('mainChart', [
            { data: dataSource.solar, color: '#fbbf24', name: 'Solar' },
            { data: dataSource.wind, color: '#22d3ee', name: 'Wind' },
            { data: dataSource.grid, color: '#a855f7', name: 'Grid' }
        ]);
        
        this.renderChart('batteryChart', [
            { data: dataSource.battery, color: '#10b981', name: 'Battery', maxY: 100 }
        ]);
    }

    renderChart(svgId, series) {
        const svg = document.getElementById(svgId);
        if (!svg) return;
        
        const width = svgId === 'mainChart' ? 600 : 300;
        const height = 200;
        const padding = 20;
        
        svg.innerHTML = '';
        
        // Draw grid lines
        for (let i = 0; i <= 5; i++) {
            const y = padding + ((height - 2 * padding) * i / 5);
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', padding);
            line.setAttribute('y1', y);
            line.setAttribute('x2', width - padding);
            line.setAttribute('y2', y);
            line.setAttribute('stroke', 'rgba(0,0,0,0.1)');
            line.setAttribute('stroke-width', '1');
            svg.appendChild(line);
        }
        
        // Draw data series
        series.forEach(s => {
            if (!s.data || s.data.length === 0) return;
            const maxY = s.maxY || Math.max(...s.data, 10);
            const points = s.data.map((value, index) => {
                const x = padding + ((width - 2 * padding) * index / Math.max(1, s.data.length - 1));
                const y = height - padding - ((height - 2 * padding) * value / maxY);
                return `${x},${y}`;
            }).join(' ');
            
            const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            polyline.setAttribute('points', points);
            polyline.setAttribute('fill', 'none');
            polyline.setAttribute('stroke', s.color);
            polyline.setAttribute('stroke-width', '2');
            polyline.setAttribute('stroke-linecap', 'round');
            polyline.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(polyline);
        });
    }

    updateKPIs() {
        // Solar
        const solar_var= (Math.random() * 20) - 10
        document.getElementById('solarVal').textContent = (Math.abs(this.state.solar+solar_var)).toFixed(2);
        document.getElementById('solarBar').style.width = `${(this.state.solar / 340) * 100}%`;
        
        // Wind
        const wind_var = (Math.random() * 10) - 8
        document.getElementById('windVal').textContent = (Math.abs(this.state.wind+wind_var)).toFixed(2);
        document.getElementById('windBar').style.width = `${(this.state.wind / 160) * 100}%`;
        
        // AI Recommendations - Solar, Wind, Demand predictions
        document.getElementById('aiSolarVal').textContent = this.state.solar.toFixed(2);
        document.getElementById('aiWindVal').textContent = this.state.wind.toFixed(2);
        document.getElementById('aiDemandVal').textContent = this.state.demand.toFixed(2);
        
        // Battery
        document.getElementById('batteryVal').textContent = `${Math.round(this.state.battery)}%`;
        document.getElementById('batteryBar').style.width = `${this.state.battery}%`;
        
        // Total Generation (Solar + Wind)
        const totalGen = this.state.totalGeneration || (this.state.solar + this.state.wind);
        document.getElementById('totalGenVal').textContent = totalGen.toFixed(2);
        document.getElementById('totalGenBar').style.width = `${(totalGen / 500) * 100}%`;
        
        // Grid Export (NEW - replaces old Grid card)
        const gridExport = this.state.gridExport || 0;
        document.getElementById('gridExportVal').textContent = gridExport.toFixed(2);
        document.getElementById('gridExportBar').style.width = `${(gridExport / 500) * 100}%`;
        
        // Data points
        document.getElementById('dataPoints').textContent = this.state.dataPoints.toLocaleString();
        
        // Update Performance Metrics
        this.updatePerformanceMetrics();
        
        // Update Export Earnings
        this.updateExportEarnings();
        
        // Update Cumulative Export Metrics
        this.updateCumulativeExportMetrics();
        
        // <new section grid import line>
        // Update Grid Import Display (always update display)
        this.updateGridImportDisplay();
        // Update Grid Import Costs (only during tick intervals)
        this.updateGridImportCosts();
        // </new section grid import line>
    }

    updatePerformanceMetrics() {
        try {
            // Calculate total generation
            const totalGen = this.state.totalGeneration || (this.state.solar + this.state.wind);
            
            // Cost Savings per hour = Total Generation * 5.3
            const costSavingsPerHour = totalGen * 5.3;
            document.getElementById('costSavings').textContent = `₹${costSavingsPerHour.toFixed(2)}`;
            
            // Cost Savings Total - accumulate and persist
            if (!this.state.costSavingsTotal) {
                // Load from localStorage on first run
                const savedCost = localStorage.getItem('costSavingsTotal');
                this.state.costSavingsTotal = savedCost ? parseFloat(savedCost) : 0;
            }
            
            // Add current hour's savings to total
            this.state.costSavingsTotal += costSavingsPerHour;
            
            // Save to localStorage for persistence
            localStorage.setItem('costSavingsTotal', this.state.costSavingsTotal.toString());
            
            // Display Cost Savings Total
            document.getElementById('costSavingsTotal').textContent = `₹${this.state.costSavingsTotal.toFixed(2)}`;
            
            // CO₂ Reduced per hour = Total Generation * 0.91 kg
            const co2ReducedPerHour = totalGen * 0.91;
            document.getElementById('co2Reduced').textContent = `${co2ReducedPerHour.toFixed(2)} kg`;
            
            // CO₂ Reduced Total - accumulate and persist
            if (!this.state.co2ReducedTotal) {
                // Load from localStorage on first run
                const saved = localStorage.getItem('co2ReducedTotal');
                this.state.co2ReducedTotal = saved ? parseFloat(saved) : 0;
            }
            
            // Add current hour's reduction to total
            this.state.co2ReducedTotal += co2ReducedPerHour;
            
            // Save to localStorage for persistence
            localStorage.setItem('co2ReducedTotal', this.state.co2ReducedTotal.toString());
            
            // Display total (convert to tons if >= 1000 kg)
            if (this.state.co2ReducedTotal >= 1000) {
                const tons = this.state.co2ReducedTotal / 1000;
                document.getElementById('co2ReducedTotal').textContent = `${tons.toFixed(2)} tons`;
            } else {
                document.getElementById('co2ReducedTotal').textContent = `${this.state.co2ReducedTotal.toFixed(2)} kg`;
            }
            
            // Efficiency - randomize between 67.25% and 70.80%
            const minEff = 67.25;
            const maxEff = 70.80;
            const randomEfficiency = minEff + Math.random() * (maxEff - minEff);
            document.getElementById('efficiency').textContent = `${randomEfficiency.toFixed(2)}%`;
            
        } catch (err) {
            console.error('Error updating performance metrics:', err);
        }
    }

    updateExportEarnings() {
        try {
            // Get current settings
            const gridRate = parseFloat(document.getElementById('gridRate')?.value || 6.0);
            const sunHours = parseFloat(document.getElementById('sunHoursSlider')?.value || 6);
            
            // Use actual grid export from state (only exports when battery = 100%)
            const exportPower = this.state.gridExport || 0;
            
            // Calculate earnings
            const hourlyEarnings = exportPower * gridRate;
            const dailyEarnings = hourlyEarnings * sunHours;
            const monthlyEarnings = dailyEarnings * 30;
            
            // Update display
            const exportNowEl = document.getElementById('exportNow');
            const hourlyEarningsEl = document.getElementById('hourlyEarnings');
            const dailyEarningsEl = document.getElementById('dailyEarnings');
            const monthlyEarningsEl = document.getElementById('monthlyEarnings');
            const exportBatteryStatusEl = document.getElementById('exportBatteryStatus');
            const exportStatusMessageEl = document.getElementById('exportStatusMessage');
            
            if (exportNowEl) exportNowEl.textContent = `${exportPower.toFixed(2)} kW`;
            if (hourlyEarningsEl) hourlyEarningsEl.textContent = `₹${hourlyEarnings.toFixed(2)}`;
            if (dailyEarningsEl) dailyEarningsEl.textContent = `₹${dailyEarnings.toFixed(2)}`;
            if (monthlyEarningsEl) monthlyEarningsEl.textContent = `₹${monthlyEarnings.toFixed(0)}`;
            
            // Update battery status in Export Earnings section
            if (exportBatteryStatusEl) exportBatteryStatusEl.textContent = `${Math.round(this.state.battery)}%`;
            if (exportStatusMessageEl) {
                if (this.state.battery <= this.state.reserve) {
                    exportStatusMessageEl.textContent = `⚠ Export stopped at reserve (${this.state.reserve}%)`;
                    exportStatusMessageEl.style.color = 'var(--danger)';
                } else if (this.state.gridExport > 0) {
                    exportStatusMessageEl.textContent = `✓ Exporting - Will stop at ${this.state.reserve}%`;
                    exportStatusMessageEl.style.color = 'var(--success)';
                } else if (this.state.battery > this.state.reserve) {
                    exportStatusMessageEl.textContent = `Ready to export - Will stop at ${this.state.reserve}%`;
                    exportStatusMessageEl.style.color = 'var(--warning)';
                } else {
                    exportStatusMessageEl.textContent = `Export will stop at ${this.state.reserve}%`;
                    exportStatusMessageEl.style.color = 'var(--text-secondary)';
                }
            }
            
            // Update export demand display
            const exportDemandDisplayEl = document.getElementById('exportDemandDisplay');
            if (exportDemandDisplayEl) {
                exportDemandDisplayEl.textContent = `${this.state.exportDemand.toFixed(0)} kW`;
            }
        } catch (err) {
            console.error('Error updating export earnings:', err);
        }
    }

    updateCumulativeExportMetrics() {
        try {
            // Get current grid rate
            const gridRate = parseFloat(document.getElementById('gridRate')?.value || 6.0);
            
            // Current export power (this is the "Exporting Now" value)
            const currentExportingNow = this.state.gridExport || 0;
            
            // Only accumulate when actually exporting (currentExportingNow > 0)
            if (currentExportingNow > 0) {
                // 1. Accumulate Grid Export Total (simple sum of export now values in kW)
                this.state.gridExportTotal += currentExportingNow;
                
                // 2. Accumulate Grid Export Income (Exporting Now × Grid Rate)
                const incomeThisTick = currentExportingNow * gridRate;
                this.state.gridExportIncome += incomeThisTick;
                
                // Debug logging
                console.log(`Tick: Export Now ${currentExportingNow.toFixed(2)} kW, Total +${currentExportingNow.toFixed(2)} kW, Income +₹${incomeThisTick.toFixed(2)}`);
            }
            
            // 3. Calculate total net income (export income - import cost)
            const totalNetIncome = this.state.gridExportIncome - this.state.gridImportCostTotal;
            
            // Update display elements
            const gridExportTotalEl = document.getElementById('gridExportTotal');
            const gridExportIncomeEl = document.getElementById('gridExportIncome');
            const totalNetIncomeEl = document.getElementById('totalNetIncome');
            
            if (gridExportTotalEl) {
                gridExportTotalEl.textContent = `${this.state.gridExportTotal.toFixed(2)} kW`;
            }
            if (gridExportIncomeEl) {
                gridExportIncomeEl.textContent = `₹${this.state.gridExportIncome.toFixed(2)}`;
            }
            if (totalNetIncomeEl) {
                totalNetIncomeEl.textContent = `₹${totalNetIncome.toFixed(2)}`;
                // Color code based on positive/negative
                if (totalNetIncome >= 0) {
                    totalNetIncomeEl.style.color = 'var(--success)';
                } else {
                    totalNetIncomeEl.style.color = 'var(--danger)';
                }
            }
            
            // Save to localStorage for persistence
            localStorage.setItem('gridExportTotal', this.state.gridExportTotal.toString());
            localStorage.setItem('gridExportIncome', this.state.gridExportIncome.toString());
            
        } catch (err) {
            console.error('Error updating cumulative export metrics:', err);
        }
    }

    // <new section grid import line>
    updateGridImportDisplay() {
        try {
            // Get grid import amount from slider (for display only)
            const gridImportAmount = this.state.gridImportAmount || 0;
            
            // Update Grid Import Card
            document.getElementById('gridImportVal').textContent = gridImportAmount.toFixed(2);
            document.getElementById('gridImportBar').style.width = `${(gridImportAmount / 500) * 100}%`;
            
            // Calculate Total Energy After Import (Total Generation + Grid Import)
            const totalGen = this.state.totalGeneration || (this.state.solar + this.state.wind);
            const totalEnergyAfterImport = totalGen + gridImportAmount;
            document.getElementById('totalEnergyAfterImportVal').textContent = totalEnergyAfterImport.toFixed(2);
            document.getElementById('totalEnergyAfterImportBar').style.width = `${(totalEnergyAfterImport / 1000) * 100}%`;
            
        } catch (err) {
            console.error('Error updating grid import display:', err);
        }
    }

    updateGridImportCosts() {
        try {
            // Calculate Grid Import Cost based on ACTUAL grid import from deficit logic
            // PLUS grid import for battery charging - this makes it independent of the 3rd card slider
            const actualGridImport = this.state.gridImport || 0; // From deficit handling
            const gridImportForBattery = this.state.gridImportAmount || 0; // From slider for battery
            const totalGridUsage = actualGridImport + gridImportForBattery;
            const costPerHour = totalGridUsage * 5.4; // Cost based on total grid usage
            document.getElementById('gridImportCostPerHour').textContent = `₹${costPerHour.toFixed(2)}`;
            
            // Accumulate Total Cost based on actual grid import only (only during tick intervals)
            if (!this.state.gridImportCostTotal) {
                // Load from localStorage on first run
                const savedCost = localStorage.getItem('gridImportCostTotal');
                this.state.gridImportCostTotal = savedCost ? parseFloat(savedCost) : 0;
            }
            
            // Add current hour's cost to total (based on actual grid import)
            this.state.gridImportCostTotal += costPerHour;
            
            // Save to localStorage for persistence
            localStorage.setItem('gridImportCostTotal', this.state.gridImportCostTotal.toString());
            
            // Display Total Cost
            document.getElementById('gridImportCostTotal').textContent = `₹${this.state.gridImportCostTotal.toFixed(2)}`;
            
        } catch (err) {
            console.error('Error updating grid import costs:', err);
        }
    }

    updateGridImportMetrics() {
        // Call both display and cost updates (for backward compatibility)
        this.updateGridImportDisplay();
        this.updateGridImportCosts();
    }
    // </new section grid import line>

    updateAIRecommendations() {
        const recommendations = document.getElementById('ai-recommendations');
        let html = '';
        
        // Generate smart recommendations based on current state
        const generation = this.state.solar + this.state.wind;
        const surplus = generation - this.state.load;
        
        if (this.state.battery < this.state.reserve + 10) {
            html += `<div class="alert alert-warning">
                <i class="fas fa-battery-quarter"></i>
                <span>Battery level is low (${Math.round(this.state.battery)}%). Consider reducing load or increasing grid usage.</span>
            </div>`;
        }
        
        if (surplus > 50) {
            html += `<div class="alert alert-success">
                <i class="fas fa-leaf"></i>
                <span>Excellent renewable generation! Surplus of ${surplus.toFixed(1)} kW available for storage or export.</span>
            </div>`;
        }
        
        if (this.state.solar < 50 && this.state.wind < 30) {
            html += `<div class="alert alert-info">
                <i class="fas fa-cloud-sun"></i>
                <span>Low renewable generation. Grid support active to maintain stable power supply.</span>
            </div>`;
        }
        
        if (this.state.demand > 4000) {
            html += `<div class="alert alert-warning">
                <i class="fas fa-exclamation-triangle"></i>
                <span>High demand predicted (${this.state.demand.toFixed(0)} kWh). Ensure adequate generation capacity.</span>
            </div>`;
        }
        
        if (html === '') {
            html = `<div class="alert alert-success">
                <i class="fas fa-check-circle"></i>
                <span>System operating optimally. All parameters within normal range.</span>
            </div>`;
        }
        
        recommendations.innerHTML = html;
        
        // Add next-hour strategic recommendations section
        this.addStrategicRecommendations();
    }

    addStrategicRecommendations() {
        const strategicContainer = document.getElementById('strategic-recommendations');
        if (!strategicContainer) return;
        
        let html = '';
        
        // Check if we have next-hour predictions
        if (this.state.nextHourPrediction) {
            const currentGen = this.state.solar + this.state.wind;
            const currentSurplus = currentGen - this.state.load;
            
            const nextGen = this.state.nextHourPrediction.solar + this.state.nextHourPrediction.wind;
            const nextSurplus = nextGen - this.state.load;
            
            const surplusThreshold = 10; // kW threshold to consider as "surplus"
            
            // Rule 1: Currently in deficit, next hour has surplus
            if (currentSurplus < -surplusThreshold && nextSurplus >= surplusThreshold) {
                html += `<div class="alert alert-info" style="background: rgba(59, 130, 246, 0.1); border-color: rgba(59, 130, 246, 0.3);">
                    <i class="fas fa-lightbulb"></i>
                    <div>
                        <strong>Discharge Strategy:</strong>
                        <span>Current deficit (${Math.abs(currentSurplus).toFixed(1)} kW), but next hour has surplus (${nextSurplus.toFixed(1)} kW). 
                        Consider discharging battery now to avoid grid purchases, then recharge from renewable surplus next hour.</span>
                    </div>
                </div>`;
            }
            
            // Rule 2: Currently in deficit, next hour also in deficit
            if (currentSurplus < -surplusThreshold && nextSurplus < -surplusThreshold) {
                html += `<div class="alert alert-warning">
                    <i class="fas fa-battery-three-quarters"></i>
                    <div>
                        <strong>Conserve Battery:</strong>
                        <span>Deficit continues into next hour (current: ${Math.abs(currentSurplus).toFixed(1)} kW, next: ${Math.abs(nextSurplus).toFixed(1)} kW). 
                        Conserve battery capacity (current: ${Math.round(this.state.battery)}%) for sustained demand. Grid support recommended.</span>
                    </div>
                </div>`;
            }
            
            // Rule 3: Currently in surplus, next hour has larger surplus
            if (currentSurplus >= surplusThreshold && nextSurplus > currentSurplus + 20) {
                html += `<div class="alert alert-success">
                    <i class="fas fa-charging-station"></i>
                    <div>
                        <strong>Optimal Charging Window:</strong>
                        <span>Current surplus: ${currentSurplus.toFixed(1)} kW, next hour increases to ${nextSurplus.toFixed(1)} kW. 
                        Charge battery now (${Math.round(this.state.battery)}%), but next hour offers even better charging opportunity with ${(nextSurplus - currentSurplus).toFixed(1)} kW more surplus.</span>
                    </div>
                </div>`;
            }
            
            // Rule 4: Currently in surplus, battery full or nearly full
            if (currentSurplus >= surplusThreshold && this.state.battery >= 90) {
                if (this.state.exportDemand > 0) {
                    html += `<div class="alert alert-success">
                        <i class="fas fa-arrow-circle-up"></i>
                        <div>
                            <strong>Export Opportunity:</strong>
                            <span>Battery nearly full (${Math.round(this.state.battery)}%) with ${currentSurplus.toFixed(1)} kW surplus. 
                            Excellent time to export at ${this.state.exportDemand} kW demand rate. Next hour generation: ${nextGen.toFixed(1)} kW.</span>
                        </div>
                    </div>`;
                } else {
                    html += `<div class="alert alert-info" style="background: rgba(59, 130, 246, 0.1); border-color: rgba(59, 130, 246, 0.3);">
                        <i class="fas fa-info-circle"></i>
                        <div>
                            <strong>Surplus Available:</strong>
                            <span>Battery full (${Math.round(this.state.battery)}%) with ${currentSurplus.toFixed(1)} kW surplus going unused. 
                            Consider setting Export Demand slider to utilize surplus and generate revenue.</span>
                        </div>
                    </div>`;
                }
            }
            
            // Rule 5: Battery at reserve level, next hour has surplus
            if (this.state.battery <= this.state.reserve + 5 && nextSurplus >= surplusThreshold) {
                html += `<div class="alert alert-warning">
                    <i class="fas fa-exclamation-triangle"></i>
                    <div>
                        <strong>Battery Recovery Opportunity:</strong>
                        <span>Battery at critical level (${Math.round(this.state.battery)}%, reserve: ${this.state.reserve}%). 
                        Next hour brings ${nextSurplus.toFixed(1)} kW surplus - perfect for recharging. Minimize current load if possible.</span>
                    </div>
                </div>`;
            }
            
            // Rule 6: Solar transition (sunrise/sunset periods)
            const currentHour = new Date().getHours();
            if ((currentHour >= 5 && currentHour <= 7) && this.state.nextHourPrediction.solar > this.state.solar + 20) {
                html += `<div class="alert alert-info" style="background: rgba(251, 191, 36, 0.1); border-color: rgba(251, 191, 36, 0.3);">
                    <i class="fas fa-sun"></i>
                    <div>
                        <strong>Sunrise Ramp-Up:</strong>
                        <span>Solar generation ramping up: current ${this.state.solar.toFixed(1)} kW → next hour ${this.state.nextHourPrediction.solar.toFixed(1)} kW. 
                        Prepare for increased renewable generation. Good time to schedule high-demand activities.</span>
                    </div>
                </div>`;
            }
            
            if ((currentHour >= 17 && currentHour <= 19) && this.state.solar > this.state.nextHourPrediction.solar + 20) {
                html += `<div class="alert alert-warning">
                    <i class="fas fa-moon"></i>
                    <div>
                        <strong>Sunset Transition:</strong>
                        <span>Solar generation declining: current ${this.state.solar.toFixed(1)} kW → next hour ${this.state.nextHourPrediction.solar.toFixed(1)} kW. 
                        Ensure battery charged (${Math.round(this.state.battery)}%) before nighttime. Wind: ${this.state.nextHourPrediction.wind.toFixed(1)} kW available.</span>
                    </div>
                </div>`;
            }
            
            // Rule 7: Wind variability alert
            const windChange = Math.abs(this.state.nextHourPrediction.wind - this.state.wind);
            if (windChange > 30) {
                const windTrend = this.state.nextHourPrediction.wind > this.state.wind ? 'increasing' : 'decreasing';
                html += `<div class="alert alert-info" style="background: rgba(34, 211, 238, 0.1); border-color: rgba(34, 211, 238, 0.3);">
                    <i class="fas fa-wind"></i>
                    <div>
                        <strong>Wind Variability:</strong>
                        <span>Significant wind change expected: ${windTrend} from ${this.state.wind.toFixed(1)} kW to ${this.state.nextHourPrediction.wind.toFixed(1)} kW (${windChange.toFixed(1)} kW change). 
                        Adjust battery strategy accordingly.</span>
                    </div>
                </div>`;
            }
            
            // Financial Strategic Recommendations (Rules 8-18)
            
            // Rule 8: Grid Rate Optimization Alert
            const gridRate = parseFloat(document.getElementById('gridRate')?.value || 6.0);
            if (gridRate < 5.0 && this.state.gridExportNow > 50) {
                html += `<div class="alert alert-warning">
                    <i class="fas fa-rupee-sign"></i>
                    <div>
                        <strong>Low Grid Rate Alert:</strong>
                        <span>Current grid rate (₹${gridRate.toFixed(1)}/kWh) is below optimal threshold. 
                        Exporting ${this.state.gridExportNow.toFixed(1)} kW at low rates. Consider storing energy for higher-rate periods or direct sales.</span>
                    </div>
                </div>`;
            }
            
            // Rule 9: High Import Cost Alert
            const gridImportCostPerHour = parseFloat(document.getElementById('gridImportCostPerHour')?.textContent?.replace('₹', '') || 0);
            if (gridImportCostPerHour > 100 && this.state.battery > this.state.reserve + 10) {
                html += `<div class="alert alert-danger">
                    <i class="fas fa-exclamation-triangle"></i>
                    <div>
                        <strong>High Import Cost Alert:</strong>
                        <span>Grid import costing ₹${gridImportCostPerHour.toFixed(0)}/hr. Battery has capacity (${Math.round(this.state.battery)}%) - 
                        consider discharging battery instead of expensive grid imports.</span>
                    </div>
                </div>`;
            }
            
            // Rule 10: Revenue Opportunity Maximization
            if (this.state.gridExportTotal > 0 && this.state.battery >= 95 && nextGen > currentGen + 30) {
                html += `<div class="alert alert-success">
                    <i class="fas fa-chart-line"></i>
                    <div>
                        <strong>Revenue Opportunity:</strong>
                        <span>Cumulative export: ${this.state.gridExportTotal.toFixed(1)} kW. Next hour generation increasing by ${(nextGen - currentGen).toFixed(1)} kW. 
                        Perfect conditions for maximizing export revenue at ₹${gridRate.toFixed(1)}/kWh.</span>
                    </div>
                </div>`;
            }
            
            // Rule 11: Net Income Target Analysis
            const totalNetIncome = parseFloat(document.getElementById('totalNetIncome')?.textContent?.replace('₹', '') || 0);
            const gridExportIncome = parseFloat(document.getElementById('gridExportIncome')?.textContent?.replace('₹', '') || 0);
            if (totalNetIncome < 0 && gridExportIncome < 50) {
                html += `<div class="alert alert-warning">
                    <i class="fas fa-target"></i>
                    <div>
                        <strong>Net Income Deficit:</strong>
                        <span>Net income: ₹${totalNetIncome.toFixed(0)} (negative). Low export income: ₹${gridExportIncome.toFixed(0)}. 
                        Focus on increasing export generation or reducing import dependency to achieve profitability.</span>
                    </div>
                </div>`;
            }
            
            // Rule 12: Break-even Analysis Alert
            const gridImportCostTotal = parseFloat(document.getElementById('gridImportCostTotal')?.textContent?.replace('₹', '') || 0);
            if (gridImportCostTotal > 0 && gridExportIncome > 0) {
                const breakEvenRatio = (gridExportIncome / gridImportCostTotal) * 100;
                if (breakEvenRatio < 80) {
                    html += `<div class="alert alert-info" style="background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.3);">
                        <i class="fas fa-balance-scale"></i>
                        <div>
                            <strong>Break-even Analysis:</strong>
                            <span>Export income covers ${breakEvenRatio.toFixed(0)}% of import costs. 
                            Need ₹${(gridImportCostTotal - gridExportIncome).toFixed(0)} more export revenue to break even.</span>
                        </div>
                    </div>`;
                }
            }
            
            // Rule 13: Export Efficiency Optimization
            if (this.state.gridExportNow > 0 && this.state.battery < 100) {
                html += `<div class="alert alert-info" style="background: rgba(147, 51, 234, 0.1); border-color: rgba(147, 51, 234, 0.3);">
                    <i class="fas fa-cogs"></i>
                    <div>
                        <strong>Export Efficiency:</strong>
                        <span>Exporting ${this.state.gridExportNow.toFixed(1)} kW while battery at ${Math.round(this.state.battery)}%. 
                        Consider prioritizing battery charging first to ensure sustained export capability.</span>
                    </div>
                </div>`;
            }
            
            // Rule 14: Cost Savings Tracking
            const costSavingsTotal = parseFloat(document.getElementById('costSavingsTotal')?.textContent?.replace('₹', '') || 0);
            if (costSavingsTotal > 500) {
                html += `<div class="alert alert-success">
                    <i class="fas fa-piggy-bank"></i>
                    <div>
                        <strong>Excellent Cost Savings:</strong>
                        <span>Total savings: ₹${costSavingsTotal.toFixed(0)}! Your renewable energy system is delivering strong financial benefits. 
                        Next hour generation: ${nextGen.toFixed(1)} kW continues the trend.</span>
                    </div>
                </div>`;
            }
            
            // Rule 15: ROI Performance Indicator
            if (this.state.gridExportTotal > 1000 && gridExportIncome > 1000) {
                const exportEfficiency = (gridExportIncome / this.state.gridExportTotal) * 100;
                html += `<div class="alert alert-info" style="background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.3);">
                    <i class="fas fa-chart-pie"></i>
                    <div>
                        <strong>ROI Performance:</strong>
                        <span>Strong export performance: ${this.state.gridExportTotal.toFixed(0)} kW total generating ₹${gridExportIncome.toFixed(0)}. 
                        Efficiency: ₹${(gridExportIncome/this.state.gridExportTotal).toFixed(2)}/kW. System ROI is tracking well.</span>
                    </div>
                </div>`;
            }
            
            // Rule 16: Peak Rate Avoidance Strategy
            if ((currentHour >= 18 && currentHour <= 22) && this.state.gridImportNow > 100) {
                html += `<div class="alert alert-danger">
                    <i class="fas fa-clock"></i>
                    <div>
                        <strong>Peak Rate Period:</strong>
                        <span>Peak demand hours (6-10 PM). Currently importing ${this.state.gridImportNow.toFixed(1)} kW at premium rates. 
                        Use battery power (${Math.round(this.state.battery)}%) or reduce load to avoid peak charges.</span>
                    </div>
                </div>`;
            }
            
            // Rule 17: Demand-Supply Balance Optimization
            const supplyDemandRatio = (currentGen + this.state.gridImportNow) / this.state.load;
            if (supplyDemandRatio > 1.5 && this.state.battery < 80) {
                html += `<div class="alert alert-info" style="background: rgba(59, 130, 246, 0.1); border-color: rgba(59, 130, 246, 0.3);">
                    <i class="fas fa-chart-bar"></i>
                    <div>
                        <strong>Supply-Demand Optimization:</strong>
                        <span>Excess supply available (${(supplyDemandRatio * 100).toFixed(0)}% of demand). 
                        Battery at ${Math.round(this.state.battery)}% - optimal time to store excess energy for later use or higher-rate export periods.</span>
                    </div>
                </div>`;
            }
            
            // Rule 18: Financial Sustainability Check
            if (totalNetIncome > 200 && this.state.gridExportTotal > 500) {
                html += `<div class="alert alert-success">
                    <i class="fas fa-leaf"></i>
                    <div>
                        <strong>Financial Sustainability:</strong>
                        <span>Positive net income: ₹${totalNetIncome.toFixed(0)}. Export performance: ${this.state.gridExportTotal.toFixed(0)} kW total. 
                        Your renewable energy system is financially sustainable and environmentally beneficial!</span>
                    </div>
                </div>`;
            }
            
        } else {
            // No next-hour data available
            html = `<div class="alert alert-info" style="background: rgba(148, 163, 184, 0.1); border-color: rgba(148, 163, 184, 0.3);">
                <i class="fas fa-clock"></i>
                <div>
                    <strong>Strategic Analysis:</strong>
                    <span>Next-hour predictions will be available once simulation starts. Strategic recommendations will appear here based on upcoming energy trends.</span>
                </div>
            </div>`;
        }
        
        strategicContainer.innerHTML = html;
    }

    updateLastUpdate() {
        document.getElementById('lastUpdate').textContent = 'Just now';
    }

    setupDashboardControls() {
        // Battery reserve slider
        document.getElementById('reserveSlider').addEventListener('input', (e) => {
            this.state.reserve = parseInt(e.target.value);
            document.getElementById('reserveValue').textContent = `${this.state.reserve}%`;
            document.getElementById('reserveDisplay').textContent = `${this.state.reserve}%`;
            this.updateExportEarnings(); // Update export message with new reserve level
            this.saveSettings();
        });

        // Battery priority slider
        document.getElementById('batteryPrioritySlider').addEventListener('input', (e) => {
            this.state.batteryPriority = parseInt(e.target.value);
            document.getElementById('batteryPriorityValue').textContent = `${this.state.batteryPriority}%`;
            this.saveSettings();
        });

        // Export demand slider
        document.getElementById('exportDemandSlider').addEventListener('input', (e) => {
            this.state.exportDemand = parseFloat(e.target.value);
            document.getElementById('exportDemandValue').textContent = `${this.state.exportDemand.toFixed(0)} kW`;
            this.updateExportEarnings(); // Update export demand display in Export Earnings card
            this.saveSettings();
        });
    }

    saveSettings() {
        const settings = {
            theme: document.body.dataset.theme,
            batteryPriority: this.state.batteryPriority,
            reserve: this.state.reserve,
            load: this.state.load,
            exportDemand: this.state.exportDemand
        };
        localStorage.setItem('energyManagementSettings', JSON.stringify(settings));
    }

    loadSettings() {
        try {
            const settings = JSON.parse(localStorage.getItem('energyManagementSettings') || '{}');
            if (settings.theme) {
                document.body.dataset.theme = settings.theme;
                this.updateThemeUI(settings.theme === 'dark');
            }
            if (settings.batteryPriority !== undefined) {
                this.state.batteryPriority = settings.batteryPriority;
                document.getElementById('batteryPrioritySlider').value = settings.batteryPriority;
                document.getElementById('batteryPriorityValue').textContent = `${settings.batteryPriority}%`;
            }
            if (settings.reserve !== undefined) {
                this.state.reserve = settings.reserve;
                document.getElementById('reserveSlider').value = settings.reserve;
                document.getElementById('reserveValue').textContent = `${settings.reserve}%`;
                document.getElementById('reserveDisplay').textContent = `${settings.reserve}%`;
            }
            if (settings.load !== undefined) {
                this.state.load = settings.load;
                // Load is now controlled by consumption slider only
            }
            if (settings.exportDemand !== undefined) {
                this.state.exportDemand = settings.exportDemand;
                document.getElementById('exportDemandSlider').value = settings.exportDemand;
                document.getElementById('exportDemandValue').textContent = `${settings.exportDemand.toFixed(0)} kW`;
            }
        } catch (error) {
            console.log('No saved settings found');
        }
    }

    updateThemeUI(isDark) {
        document.getElementById('themeIcon').className = isDark ? 'fas fa-sun' : 'fas fa-moon';
        document.getElementById('themeLabel').textContent = isDark ? 'Light Mode' : 'Dark Mode';
    }

    toggleTheme() {
        const currentTheme = document.body.dataset.theme;
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.body.dataset.theme = newTheme;
        this.updateThemeUI(newTheme === 'dark');
        this.saveSettings();
    }

    updateDateTime() {
        const now = new Date();
        const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
        document.getElementById('currentDateTime').textContent = now.toLocaleDateString('en-US', options);
    }

    showAlert(message, type = 'info') {
        const container = document.getElementById('alertContainer');
        const alertClass = type === 'success' ? 'alert-success' : 
                          type === 'warning' ? 'alert-warning' : 
                          type === 'error' ? 'alert-danger' : 'alert-info';
        const icon = type === 'success' ? 'fas fa-check-circle' : 
                    type === 'warning' ? 'fas fa-exclamation-triangle' : 
                    type === 'error' ? 'fas fa-times-circle' : 'fas fa-info-circle';
        
        container.innerHTML = `
            <div class="alert ${alertClass}">
                <i class="${icon}"></i>
                <span>${message}</span>
            </div>
        `;
        setTimeout(() => {
            container.innerHTML = '';
        }, 5000);
    }

    switchTab(tab) {
        this.state.currentTab = tab;
        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.tab === tab) {
                btn.classList.add('active');
            }
        });
        this.updateCharts();
    }

    generateForecastData() {
        this.state.forecast = { solar: [], wind: [], grid: [], battery: [] };
        for (let i = 0; i < 24; i++) {
            const hour = i;
            const solarFactor = Math.max(0, Math.sin((hour - 6) * Math.PI / 12));
            const windVariation = 0.8 + Math.random() * 0.4;
            this.state.forecast.solar.push(solarFactor * 300 * (0.9 + Math.random() * 0.2));
            this.state.forecast.wind.push(this.state.windSpeed * 8 * windVariation);
            this.state.forecast.grid.push(Math.max(0, 50 - (this.state.forecast.solar[i] + this.state.forecast.wind[i]) + Math.random() * 20));
            this.state.forecast.battery.push(Math.min(100, Math.max(20, 60 + Math.sin(i * Math.PI / 12) * 30)));
        }
    }

    generateHistoricalData() {
        this.state.historical = { solar: [], wind: [], grid: [], battery: [] };
        for (let i = 0; i < 30; i++) {
            const dayVariation = 0.7 + Math.random() * 0.6;
            const seasonalFactor = 0.8 + Math.sin((i + 180) * Math.PI / 180) * 0.3;
            this.state.historical.solar.push(200 * dayVariation * seasonalFactor);
            this.state.historical.wind.push(80 + Math.random() * 60);
            this.state.historical.grid.push(30 + Math.random() * 40);
            this.state.historical.battery.push(40 + Math.random() * 50);
        }
    }
}

// ===== AI Simulation Controller =====
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Energy Management System
    const ems = new EnergyManagementSystem();
    window.ems = ems; // Expose globally
    
    // Start datetime updates
    ems.updateDateTime();
    setInterval(() => ems.updateDateTime(), 60000); // Update every minute
    
    // Load saved settings
    ems.loadSettings();
    
    // Setup dashboard controls
    ems.setupDashboardControls();

    // --- DOM Elements ---
    const uploadForm = document.getElementById('upload-form');
    const csvFileInput = document.getElementById('csv-file');
    const uploadSection = document.getElementById('upload-section');
    const startBtn = document.getElementById('start-sim-btn');
    const stopBtn = document.getElementById('stop-sim-btn');
    const statusLog = document.getElementById('status-log');
    const currentTimeDisplay = document.getElementById('current-time-display');
    const liveIndicator = document.getElementById('liveIndicator');
    const liveStatus = document.getElementById('liveStatus');

    // Slider controls
    const controls = {
        consumption: { input: document.getElementById('consumption'), value: document.getElementById('consumption-value') },
        wind_speed: { input: document.getElementById('wind_speed'), value: document.getElementById('wind_speed-value') },
        cloud_coverage: { input: document.getElementById('cloud_coverage'), value: document.getElementById('cloud_coverage-value') },
        temperature: { input: document.getElementById('temperature'), value: document.getElementById('temperature-value') },
        irradiance: { input: document.getElementById('irradiance'), value: document.getElementById('irradiance-value') },
        holiday: { input: document.getElementById('holiday') }
    };

    // --- State Variables ---
    let simulationInterval = null;
    let currentSimDate = null;

    // --- Helper Functions ---
    const logMessage = (message, isError = false) => {
        const now = new Date().toLocaleTimeString();
        const color = isError ? '#ff6b6b' : '#6bffb8';
        const icon = isError ? '✗' : '✓';
        statusLog.innerHTML = `<div style="color: ${color}; margin-bottom: 4px;">[${now}] ${icon} ${message}</div>` + statusLog.innerHTML;
    };

    const formatDateForAPI = (date) => {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${day}${month}${year}`;
    };

    const updateTimeDisplay = () => {
        const hours = String(currentSimDate.getHours()).padStart(2, '0');
        const minutes = String(currentSimDate.getMinutes()).padStart(2, '0');
        const dateStr = currentSimDate.toLocaleDateString();
        currentTimeDisplay.textContent = `${dateStr}, ${hours}:${minutes}`;
    };

    // --- Event Listeners ---

    // Update slider value displays
    Object.values(controls).forEach(control => {
        if (control.input && control.input.type === 'range') {
            control.input.addEventListener('input', () => {
                control.value.textContent = control.input.value;
            });
        }
    });

    // Link consumption slider to Site Load (they should be synchronized)
    if (controls.consumption && controls.consumption.input) {
        controls.consumption.input.addEventListener('input', (e) => {
            const consumptionWh = parseFloat(e.target.value);
            const consumptionKW = consumptionWh / 1000; // Convert Wh to kW
            ems.state.load = consumptionKW;
            
            console.log(`[LOAD] Consumption slider: ${consumptionWh} Wh → Load: ${consumptionKW.toFixed(2)} kW`);
        });
    }

    // Theme toggle
    document.getElementById('themeToggle').addEventListener('click', () => {
        ems.toggleTheme();
    });

    // Tab switching for Analytics & Trends
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tab = e.currentTarget.dataset.tab;
            ems.switchTab(tab);
        });
    });

    // Generate forecast and historical data
    ems.generateForecastData();
    ems.generateHistoricalData();
    ems.updateCharts();

    // Initialize current date/time display to real-time
    const now = new Date();
    document.getElementById('currentDate').textContent = now.toLocaleDateString();
    document.getElementById('currentTime').textContent = now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    // Initialize simulation time to current real-time
    currentSimDate = new Date();
    currentTimeDisplay.textContent = `${currentSimDate.toLocaleDateString()}, ${String(currentSimDate.getHours()).padStart(2, '0')}:${String(currentSimDate.getMinutes()).padStart(2, '0')}`;
    
    // Update date/time displays every minute for real-time sync when not simulating
    setInterval(() => {
        if (!simulationInterval) {
            // Only update if simulation is not running
            const realTimeNow = new Date();
            document.getElementById('currentDate').textContent = realTimeNow.toLocaleDateString();
            document.getElementById('currentTime').textContent = realTimeNow.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            
            // Update simulation time to match real-time when idle
            currentSimDate = new Date(realTimeNow);
            currentTimeDisplay.textContent = `${currentSimDate.toLocaleDateString()}, ${String(currentSimDate.getHours()).padStart(2, '0')}:${String(currentSimDate.getMinutes()).padStart(2, '0')}`;
        }
    }, 60000); // Update every minute

    // Settings modal
    document.getElementById('settingsBtn').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.remove('hidden');
        document.getElementById('settingsModal').classList.add('flex');
    });

    document.getElementById('closeSettings').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.add('hidden');
        document.getElementById('settingsModal').classList.remove('flex');
    });

    document.getElementById('saveSettings').addEventListener('click', () => {
        ems.saveSettings();
        ems.showAlert('Settings saved successfully', 'success');
        document.getElementById('settingsModal').classList.add('hidden');
        document.getElementById('settingsModal').classList.remove('flex');
    });

    document.getElementById('resetSettings').addEventListener('click', () => {
        localStorage.removeItem('energyManagementSettings');
        ems.showAlert('Settings reset. Refresh page to apply defaults.', 'info');
    });

    // Export data
    document.getElementById('exportBtn').addEventListener('click', () => {
        const data = {
            timestamp: new Date().toISOString(),
            state: ems.state
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `energy-data-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        ems.showAlert('Data exported successfully', 'success');
    });

    // Scenario buttons
    document.querySelectorAll('.scenario-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const scenario = e.currentTarget.dataset.scenario;
            applyScenario(scenario);
        });
    });

    function applyScenario(scenario) {
        switch(scenario) {
            case 'sunny':
                controls.temperature.input.value = 35;
                controls.temperature.value.textContent = '35';
                controls.cloud_coverage.input.value = 10;
                controls.cloud_coverage.value.textContent = '10';
                controls.irradiance.input.value = 1100;
                controls.irradiance.value.textContent = '1100';
                controls.wind_speed.input.value = 15;
                controls.wind_speed.value.textContent = '15';
                ems.showAlert('Applied Sunny scenario', 'success');
                break;
            case 'cloudy':
                controls.temperature.input.value = 22;
                controls.temperature.value.textContent = '22';
                controls.cloud_coverage.input.value = 80;
                controls.cloud_coverage.value.textContent = '80';
                controls.irradiance.input.value = 200;
                controls.irradiance.value.textContent = '200';
                controls.wind_speed.input.value = 25;
                controls.wind_speed.value.textContent = '25';
                ems.showAlert('Applied Cloudy scenario', 'success');
                break;
            case 'storm':
                controls.temperature.input.value = 18;
                controls.temperature.value.textContent = '18';
                controls.cloud_coverage.input.value = 95;
                controls.cloud_coverage.value.textContent = '95';
                controls.irradiance.input.value = 50;
                controls.irradiance.value.textContent = '50';
                controls.wind_speed.input.value = 80;
                controls.wind_speed.value.textContent = '80';
                ems.showAlert('Applied Storm scenario', 'success');
                break;
            case 'evening':
                controls.temperature.input.value = 20;
                controls.temperature.value.textContent = '20';
                controls.cloud_coverage.input.value = 30;
                controls.cloud_coverage.value.textContent = '30';
                controls.irradiance.input.value = 0;
                controls.irradiance.value.textContent = '0';
                controls.wind_speed.input.value = 10;
                controls.wind_speed.value.textContent = '10';
                ems.showAlert('Applied Evening scenario', 'success');
                break;
        }
    }

    // Optimize button
    document.getElementById('optimizeBtn').addEventListener('click', () => {
        // Smart optimization based on current conditions
        const batteryLevel = ems.state.battery;
        const generation = ems.state.solar + ems.state.wind;
        const load = ems.state.load;
        const balance = generation - load;
        
        console.log(`[OPTIMIZE] Battery: ${batteryLevel.toFixed(1)}%, Generation: ${generation.toFixed(2)} kW, Load: ${load.toFixed(2)} kW, Balance: ${balance.toFixed(2)} kW`);
        
        if (batteryLevel < 30 && balance > 0) {
            // Low battery + surplus = prioritize charging
            ems.state.batteryPriority = 90;
            document.getElementById('batteryPrioritySlider').value = 90;
            document.getElementById('batteryPriorityValue').textContent = '90%';
            ems.showAlert('Optimized: High battery priority to charge rapidly (Low battery + Surplus)', 'success');
        } else if (batteryLevel > 80 && balance < 0) {
            // High battery + deficit = use battery more
            ems.state.batteryPriority = 90;
            document.getElementById('batteryPrioritySlider').value = 90;
            document.getElementById('batteryPriorityValue').textContent = '90%';
            ems.showAlert('Optimized: High battery priority to supply deficit (High battery + Deficit)', 'success');
        } else if (batteryLevel > 80 && balance > 0) {
            // High battery + surplus = low priority, let grid take it
            ems.state.batteryPriority = 30;
            document.getElementById('batteryPrioritySlider').value = 30;
            document.getElementById('batteryPriorityValue').textContent = '30%';
            ems.showAlert('Optimized: Low battery priority (Already charged)', 'info');
        } else if (batteryLevel < 30 && balance < 0) {
            // Low battery + deficit = moderate priority, save battery
            ems.state.batteryPriority = 40;
            document.getElementById('batteryPrioritySlider').value = 40;
            document.getElementById('batteryPriorityValue').textContent = '40%';
            ems.showAlert('Optimized: Moderate battery priority (Low battery, preserving charge)', 'warning');
        } else {
            // Normal conditions = balanced
            ems.state.batteryPriority = 60;
            document.getElementById('batteryPrioritySlider').value = 60;
            document.getElementById('batteryPriorityValue').textContent = '60%';
            ems.showAlert('Optimized: Balanced battery priority for normal conditions', 'info');
        }
        
        ems.saveSettings();
        // Trigger immediate recalculation
        ems.updateKPIs();
    });

    // Reset button
    document.getElementById('resetBtn').addEventListener('click', () => {
        // Reset Load via Consumption slider
        if (controls.consumption && controls.consumption.input) {
            controls.consumption.input.value = 250;
            controls.consumption.display.textContent = '250';
        }
        ems.state.load = 0.25; // 250 Wh = 0.25 kW
        
        // Reset Battery Priority
        document.getElementById('batteryPrioritySlider').value = 50;
        document.getElementById('batteryPriorityValue').textContent = '50%';
        ems.state.batteryPriority = 50;
        
        // Reset Battery Reserve
        document.getElementById('reserveSlider').value = 20;
        document.getElementById('reserveValue').textContent = '20%';
        ems.state.reserve = 20;
        
        // Reset Export Demand
        document.getElementById('exportDemandSlider').value = 0;
        document.getElementById('exportDemandValue').textContent = '0 kW';
        ems.state.exportDemand = 0;
        
        ems.saveSettings();
        ems.showAlert('Settings reset to defaults', 'info');
    });

    // Update Prediction button
    document.getElementById('updatePrediction').addEventListener('click', () => {
        if (simulationInterval) {
            ems.showAlert('Predictions are updating automatically during simulation', 'info');
        } else {
            ems.showAlert('Start the simulation to get AI predictions', 'warning');
        }
    });

    // Apply Recommendation button
    document.getElementById('applyRecommendation').addEventListener('click', () => {
        ems.showAlert('Auto-optimization applied based on AI recommendations', 'success');
        document.getElementById('optimizeBtn').click();
    });

    // Refresh Weather button
    document.getElementById('refreshWeather').addEventListener('click', () => {
        const now = new Date();
        document.getElementById('currentDate').textContent = now.toLocaleDateString();
        document.getElementById('currentTime').textContent = now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        // Also sync simulation time if not running
        if (!simulationInterval) {
            currentSimDate = new Date(now);
            currentTimeDisplay.textContent = `${currentSimDate.toLocaleDateString()}, ${String(currentSimDate.getHours()).padStart(2, '0')}:${String(currentSimDate.getMinutes()).padStart(2, '0')}`;
        }
        
        ems.showAlert('Environmental data and time synced to current real-time', 'success');
    });

    // Export Earnings Controls (removed exportShareSlider - now automatic based on battery)
    const gridRateInput = document.getElementById('gridRate');
    const sunHoursSlider = document.getElementById('sunHoursSlider');
    const sunHoursValue = document.getElementById('sunHoursValue');

    if (gridRateInput) {
        gridRateInput.addEventListener('input', () => {
            ems.updateExportEarnings();
            // Note: We don't call updateCumulativeExportMetrics here because 
            // cumulative income should only be calculated during ticks, not when rate changes
        });
    }

    if (sunHoursSlider) {
        sunHoursSlider.addEventListener('input', (e) => {
            sunHoursValue.textContent = `${e.target.value}h`;
            ems.updateExportEarnings();
        });
    }

    // Initialize export earnings on page load
    ems.updateExportEarnings();
    ems.updateCumulativeExportMetrics();

    // <new section grid import line>
    // Grid Import Slider Control
    const gridImportSlider = document.getElementById('gridImportSlider');
    const gridImportSliderValue = document.getElementById('gridImportSliderValue');
    
    if (gridImportSlider) {
        gridImportSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            ems.state.gridImportAmount = value;
            gridImportSliderValue.textContent = value.toFixed(2);
            
            // Update slider background (visual progress)
            const percentage = (value / 500) * 100;
            e.target.style.background = `linear-gradient(to right, #8b5cf6 0%, #8b5cf6 ${percentage}%, rgba(148, 163, 184, 0.2) ${percentage}%)`;
            
            // Only update display elements, NOT costs (costs should only update with tick intervals)
            ems.updateGridImportDisplay();
        });
    }
    
    // Initialize grid import display on page load (costs will be calculated during first tick)
    ems.updateGridImportDisplay();
    // </new section grid import line>

    // CSV Upload
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const file = csvFileInput.files[0];
        if (!file) {
            ems.showAlert('Please select a CSV file first', 'error');
            logMessage('No file selected', true);
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        try {
            logMessage('Uploading CSV file...');
            document.getElementById('aiModelStatus').textContent = 'Loading...';
            
            const response = await fetch('/api/upload_csv', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Failed to upload file');
            }

            logMessage('CSV uploaded successfully!');
            ems.showAlert(`Data loaded successfully! ${result.rows} rows loaded. AI models initialized.`, 'success');
            
            // Initialize simulation date to current real-time (not from CSV)
            currentSimDate = new Date();
            
            // Hide upload section
            uploadSection.classList.add('hidden');
            document.getElementById('aiModelStatus').textContent = 'Active';
            
            // Enable simulation buttons
            startBtn.disabled = false;
            
            updateTimeDisplay();
            logMessage('Ready to start simulation from current time');
            
            // Update current date/time display to current real-time
            const now = new Date();
            document.getElementById('currentDate').textContent = now.toLocaleDateString();
            document.getElementById('currentTime').textContent = now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

        } catch (error) {
            ems.showAlert(`Upload failed: ${error.message}`, 'error');
            logMessage(`Upload Error: ${error.message}`, true);
            document.getElementById('aiModelStatus').textContent = 'Error';
        }
    });

    // Start Simulation
    startBtn.addEventListener('click', () => {
        if (simulationInterval) return;
        
        logMessage('Starting live AI simulation...');
        ems.showAlert('Live simulation started - AI predictions updating every 3 seconds', 'success');
        
        startBtn.disabled = true;
        stopBtn.disabled = false;
        liveIndicator.classList.add('animate-spin');
        liveStatus.textContent = 'Live predictions active';
        document.getElementById('systemStatus').textContent = 'Simulation Running';
        
        runTick();
        simulationInterval = setInterval(runTick, 3000);
    });

    // Stop Simulation
    stopBtn.addEventListener('click', () => {
        if (!simulationInterval) return;
        
        clearInterval(simulationInterval);
        simulationInterval = null;
        
        logMessage('Simulation stopped');
        ems.showAlert('Simulation paused', 'info');
        
        startBtn.disabled = false;
        stopBtn.disabled = true;
        liveIndicator.classList.remove('animate-spin');
        liveStatus.textContent = 'Simulation paused';
        document.getElementById('systemStatus').textContent = 'System Online';
    });

    // --- Core Simulation Logic ---
    const runTick = async () => {
        // Advance time by 1 hour
        currentSimDate.setHours(currentSimDate.getHours() + 1);
        updateTimeDisplay();

        // Gather current data from sliders
        const tickData = {
            date: formatDateForAPI(currentSimDate),
            time: currentSimDate.getHours(),
            consumption: parseFloat(controls.consumption.input.value),
            holiday: controls.holiday.input.checked ? 1 : 0,
            wind_speed: parseFloat(controls.wind_speed.input.value),
            cloud_coverage: parseFloat(controls.cloud_coverage.input.value),
            temperature: parseFloat(controls.temperature.input.value),
            irradiance: parseFloat(controls.irradiance.input.value)
        };
        
        // Prepare next-hour data for strategic recommendations
        const nextHourDate = new Date(currentSimDate);
        nextHourDate.setHours(nextHourDate.getHours() + 1);
        const nextHourData = {
            date: formatDateForAPI(nextHourDate),
            time: nextHourDate.getHours(),
            consumption: parseFloat(controls.consumption.input.value),
            holiday: controls.holiday.input.checked ? 1 : 0,
            wind_speed: parseFloat(controls.wind_speed.input.value),
            cloud_coverage: parseFloat(controls.cloud_coverage.input.value),
            temperature: parseFloat(controls.temperature.input.value),
            irradiance: parseFloat(controls.irradiance.input.value)
        };

        try {
            // Send tick data to server
            const tickResponse = await fetch('/api/tick', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tickData)
            });
            
            if (!tickResponse.ok) {
                throw new Error('Failed to send tick data');
            }

            // Request current hour predictions
            const predictResponse = await fetch('/api/predict', { method: 'POST' });
            if (!predictResponse.ok) {
                throw new Error('Failed to fetch predictions');
            }
            
            const predictions = await predictResponse.json();
            
            // Send next-hour data to server (for next-hour prediction)
            await fetch('/api/tick', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(nextHourData)
            });
            
            // Request next-hour predictions
            let nextHourPrediction = null;
            try {
                const nextPredictResponse = await fetch('/api/predict', { method: 'POST' });
                if (nextPredictResponse.ok) {
                    nextHourPrediction = await nextPredictResponse.json();
                }
            } catch (err) {
                console.warn('Could not fetch next-hour predictions:', err);
            }

            // Update EMS with backend predictions and next-hour prediction
            ems.updateFromBackend(predictions, tickData, nextHourPrediction);
            
            logMessage(`Predictions updated: Solar=${predictions.solar_gen?.toFixed(1)}kW, Wind=${predictions.wind_gen?.toFixed(1)}kW, Demand=${predictions.demand_forecast?.toFixed(0)}kWh`);

            // Check for errors
            if (predictions.solar_error) logMessage(`Solar: ${predictions.solar_error}`, true);
            if (predictions.wind_error) logMessage(`Wind: ${predictions.wind_error}`, true);
            if (predictions.demand_error) logMessage(`Demand: ${predictions.demand_error}`, true);

        } catch (error) {
            logMessage(`Error: ${error.message}`, true);
            ems.showAlert(`Simulation error: ${error.message}`, 'error');
            stopBtn.click();
        }
    };
});